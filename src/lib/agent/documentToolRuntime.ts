import type { YjsProvider } from '@durable-streams/y-durable-streams'
import {
  createAgentTransactionOrigin,
  createServerAgentSession,
  type ServerAgentSession,
} from './serverAgentSession'
import {
  fragmentToMarkdown,
  writeMarkdownToFragment,
  fragmentMapping,
  pmSizeForMarkdown,
} from '../editor/fragmentMarkdown'
import type { AgentRunMode, AgentTransactionOrigin } from './types'
import type { EditorContextPayload } from './editorContext'

/**
 * Server-side editing runtime. The document's source of truth is a collaborative
 * `Y.XmlFragment` edited natively by the TipTap editor. The AI thinks in GitBook
 * markdown, so this runtime reads the fragment as markdown, applies string edits,
 * and writes the result back through the shared fragment<->markdown bridge.
 *
 * Positions are plain string offsets into the markdown (re-derived per call), so
 * there is no separate anchor type to keep in sync.
 */

function waitForProviderSync(provider: YjsProvider, timeoutMs: number): Promise<void> {
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      provider.off('synced', onSync)
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for Yjs provider sync`))
    }, timeoutMs)
    const onSync = (synced: boolean) => {
      if (synced) {
        clearTimeout(t)
        provider.off('synced', onSync)
        resolve()
      }
    }
    provider.on('synced', onSync)
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function normalizeRange(from: number, to: number): { from: number; to: number } {
  return from <= to ? { from, to } : { from: to, to: from }
}

function preview(text: string, index: number, queryLength: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, index - 40), index),
    after: text.slice(index + queryLength, Math.min(text.length, index + queryLength + 40)),
  }
}

function lineBounds(s: string, from: number, to: number): { start: number; end: number } {
  const start = s.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  let end = s.indexOf('\n', to)
  if (end < 0) end = s.length
  return { start, end }
}

function stripLeadingBlockMarkers(line: string): string {
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, '')
}

export interface SearchMatchResult {
  matchId: string
  text: string
  before: string
  after: string
}

export type FormatKind = 'mark' | 'block'
export type FormatName =
  | 'bold'
  | 'italic'
  | 'code'
  | 'paragraph'
  | 'heading'
  | 'bullet_list'
  | 'ordered_list'
export type FormatAction = 'add' | 'remove' | 'toggle' | 'set'
export type ContentFormat = 'plain_text' | 'markdown'

export interface StreamingEditGenerationContext {
  mode: AgentRunMode
  contentFormat: ContentFormat
  documentContext: string
  selectionText?: string
  signal?: AbortSignal
}

export type StreamingEditContentGenerator = (
  ctx: StreamingEditGenerationContext,
) => AsyncIterable<string>

export interface StreamingEditEventEmitter {
  start: (value: { messageId: string; mode: AgentRunMode; contentFormat: ContentFormat }) => void
  delta: (value: { messageId: string; delta: string }) => void
  end: (value: { messageId: string; committedChars: number; cancelled?: boolean }) => void
}

export type CompletedDocumentMutation =
  | { kind: 'insert_text'; insertedChars: number }
  | { kind: 'insert_paragraph_break' }
  | { kind: 'replace_matches'; replacedCount: number; insertedChars: number }
  | { kind: 'delete_selection' }
  | { kind: 'set_format'; formatKind: FormatKind; format: FormatName; action: FormatAction | 'set' }
  | {
      kind: 'streaming_edit'
      mode: AgentRunMode
      contentFormat: ContentFormat
      committedChars: number
      cancelled?: boolean
    }

interface MatchHandle {
  matchId: string
  text: string
  start: number
  end: number
}

interface ActiveStreamingEdit {
  id: string
  mode: AgentRunMode
  contentFormat: ContentFormat
  // Stable segments captured once at start; we rebuild the whole markdown as
  // `before + buffer + after` on each delta rather than splicing into the
  // re-serialized fragment text (which drifts and mangles partial markdown).
  before: string
  after: string
  buffer: string
  originalText: string
  committedChars: number
  deletedSelectionText?: string
}

const MARK_DELIMITER: Record<'bold' | 'italic' | 'code', string> = {
  bold: '**',
  italic: '*',
  code: '`',
}

let MATCH_SEQ = 0

// Coalesce streamed writes to this cadence (ms) instead of writing per token.
const STREAM_FLUSH_MS = 120

export class DocumentToolRuntime {
  private readonly origin: AgentTransactionOrigin
  private cursor = 0
  private selection: { from: number; to: number } | null = null
  private readonly matches = new Map<string, MatchHandle>()
  private activeEdit: ActiveStreamingEdit | null = null
  private streamingEditGenerator: StreamingEditContentGenerator | undefined
  private readonly completedMutations: CompletedDocumentMutation[] = []

  private constructor(
    private readonly session: ServerAgentSession,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.origin = createAgentTransactionOrigin(session.sessionId)
  }

  static async create(input: {
    docKey: string
    sessionId: string
    signal?: AbortSignal
    editorContext?: EditorContextPayload
    streamingEditGenerator?: StreamingEditContentGenerator
  }): Promise<DocumentToolRuntime> {
    const session = createServerAgentSession(input.docKey, input.sessionId)
    const runtime = new DocumentToolRuntime(session, input.signal)
    runtime.streamingEditGenerator = input.streamingEditGenerator
    await waitForProviderSync(session.provider, 20_000)
    runtime.cursor = runtime.text().length
    session.setStatus('idle')
    return runtime
  }

  static createForSession(input: {
    session: ServerAgentSession
    signal?: AbortSignal
    editorContext?: EditorContextPayload
    streamingEditGenerator?: StreamingEditContentGenerator
  }): DocumentToolRuntime {
    const runtime = new DocumentToolRuntime(input.session, input.signal)
    runtime.streamingEditGenerator = input.streamingEditGenerator
    runtime.cursor = runtime.text().length
    input.session.setStatus('idle')
    return runtime
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw new DOMException('Agent run aborted', 'AbortError')
  }

  // ── markdown <-> fragment ───────────────────────────────────────────────

  private text(): string {
    return fragmentToMarkdown(this.session.fragment)
  }

  private write(md: string): void {
    writeMarkdownToFragment(this.session.ydoc, this.session.fragment, md, this.origin)
  }

  private spliceText(from: number, to: number, insert: string): number {
    const s = this.text()
    const range = normalizeRange(clamp(from, 0, s.length), clamp(to, 0, s.length))
    const next = s.slice(0, range.from) + insert + s.slice(range.to)
    this.write(next)
    return range.from + insert.length
  }

  getCompletedMutations(): ReadonlyArray<CompletedDocumentMutation> {
    return this.completedMutations
  }

  getCompletedMutationCount(): number {
    return this.completedMutations.length
  }

  private resolveSelection(): { from: number; to: number } | null {
    if (!this.selection) return null
    const len = this.text().length
    return normalizeRange(clamp(this.selection.from, 0, len), clamp(this.selection.to, 0, len))
  }

  /** Re-find a stored match in the current text (handles drift from edits). */
  private resolveMatch(handle: MatchHandle): { from: number; to: number } {
    const s = this.text()
    if (s.slice(handle.start, handle.end) === handle.text) {
      return { from: handle.start, to: handle.end }
    }
    const found = s.indexOf(handle.text)
    if (found < 0) throw new Error(`Match no longer present: ${handle.matchId}`)
    return { from: found, to: found + handle.text.length }
  }

  // ── reads ───────────────────────────────────────────────────────────────

  getDocumentSnapshot(
    maxChars: number = 6000,
    startChar: number = 0,
  ): { text: string; charCount: number; startChar: number; endChar: number } {
    const text = this.text()
    const safeStart = clamp(startChar, 0, text.length)
    const safeEnd = clamp(safeStart + maxChars, safeStart, text.length)
    return { text: text.slice(safeStart, safeEnd), charCount: text.length, startChar: safeStart, endChar: safeEnd }
  }

  getSelectionSnapshot(
    maxCharsBefore: number = 120,
    maxCharsAfter: number = 120,
  ): { text: string; from: number; to: number; before: string; after: string } | null {
    const selection = this.resolveSelection()
    if (!selection) return null
    const s = this.text()
    return {
      text: s.slice(selection.from, selection.to),
      from: selection.from,
      to: selection.to,
      before: s.slice(Math.max(0, selection.from - maxCharsBefore), selection.from),
      after: s.slice(selection.to, Math.min(s.length, selection.to + maxCharsAfter)),
    }
  }

  getCursorContext(
    maxCharsBefore: number = 120,
    maxCharsAfter: number = 120,
  ): { before: string; after: string } | null {
    const s = this.text()
    const pos = clamp(this.cursor, 0, s.length)
    return {
      before: s.slice(Math.max(0, pos - maxCharsBefore), pos),
      after: s.slice(pos, Math.min(s.length, pos + maxCharsAfter)),
    }
  }

  searchText(query: string, maxResults: number = 8): SearchMatchResult[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    const s = this.text()
    const results: SearchMatchResult[] = []
    let fromIndex = 0
    while (results.length < maxResults) {
      const found = s.indexOf(trimmed, fromIndex)
      if (found < 0) break
      const matchId = `m${++MATCH_SEQ}`
      this.matches.set(matchId, { matchId, text: trimmed, start: found, end: found + trimmed.length })
      results.push({ matchId, text: trimmed, ...preview(s, found, trimmed.length) })
      fromIndex = found + Math.max(1, trimmed.length)
    }
    return results
  }

  // ── cursor / selection ────────────────────────────────────────────────

  placeCursor(matchId: string, edge: 'start' | 'end' = 'start'): { ok: true; cursorAnchorB64: string } {
    const handle = this.matches.get(matchId)
    if (!handle) throw new Error(`Unknown matchId: ${matchId}`)
    const range = this.resolveMatch(handle)
    this.cursor = edge === 'start' ? range.from : range.to
    this.selection = null
    return { ok: true, cursorAnchorB64: String(this.cursor) }
  }

  placeCursorAtDocumentBoundary(
    boundary: 'start' | 'end',
  ): { ok: true; cursorAnchorB64: string; boundary: 'start' | 'end' } {
    this.cursor = boundary === 'start' ? 0 : this.text().length
    this.selection = null
    return { ok: true, cursorAnchorB64: String(this.cursor), boundary }
  }

  selectText(matchId: string): { ok: true; selectedText: string } {
    const handle = this.matches.get(matchId)
    if (!handle) throw new Error(`Unknown matchId: ${matchId}`)
    const range = this.resolveMatch(handle)
    this.selection = range
    this.cursor = range.to
    return { ok: true, selectedText: handle.text }
  }

  selectCurrentBlock(): { ok: true; selectedText: string } {
    const s = this.text()
    const { start, end } = lineBounds(s, this.cursor, this.cursor)
    this.selection = { from: start, to: end }
    this.cursor = end
    return { ok: true, selectedText: s.slice(start, end) }
  }

  selectBetweenMatches(
    startMatchId: string,
    endMatchId: string,
    startEdge: 'start' | 'end' = 'start',
    endEdge: 'start' | 'end' = 'end',
  ): { ok: true } {
    const startHandle = this.matches.get(startMatchId)
    const endHandle = this.matches.get(endMatchId)
    if (!startHandle || !endHandle) throw new Error('Unknown matchId in select_between_matches')
    const startRange = this.resolveMatch(startHandle)
    const endRange = this.resolveMatch(endHandle)
    const from = startEdge === 'start' ? startRange.from : startRange.to
    const to = endEdge === 'start' ? endRange.from : endRange.to
    this.selection = normalizeRange(from, to)
    this.cursor = this.selection.to
    return { ok: true }
  }

  clearSelection(): { ok: true } {
    this.selection = null
    return { ok: true }
  }

  // ── edits ─────────────────────────────────────────────────────────────

  insertParagraphBreak(): { ok: true } {
    this.throwIfAborted()
    this.cursor = this.spliceText(this.cursor, this.cursor, '\n\n')
    this.selection = null
    this.completedMutations.push({ kind: 'insert_paragraph_break' })
    return { ok: true }
  }

  setFormat(input: {
    kind: FormatKind
    format: FormatName
    action?: FormatAction
    level?: number
  }): { ok: true; kind: FormatKind; format: FormatName; action: FormatAction } {
    this.throwIfAborted()
    const selection = this.resolveSelection()
    if (!selection) throw new Error('Formatting requires an active selection')
    const action = input.action ?? (input.kind === 'mark' ? 'toggle' : 'set')
    const s = this.text()

    if (input.kind === 'mark') {
      const delim = MARK_DELIMITER[input.format as 'bold' | 'italic' | 'code']
      if (!delim) throw new Error(`Unsupported mark format: ${input.format}`)
      const inner = s.slice(selection.from, selection.to)
      const wrapped = inner.startsWith(delim) && inner.endsWith(delim) && inner.length >= delim.length * 2
      const remove = action === 'remove' || (action === 'toggle' && wrapped)
      const next = remove ? inner.slice(delim.length, inner.length - delim.length) : `${delim}${inner}${delim}`
      const end = this.spliceText(selection.from, selection.to, next)
      this.selection = { from: selection.from, to: end }
      this.cursor = end
    } else {
      const bounds = lineBounds(s, selection.from, selection.to)
      const lines = s.slice(bounds.start, bounds.end).split('\n')
      const transformed = lines.map((line, i) => {
        const bare = stripLeadingBlockMarkers(line)
        switch (input.format) {
          case 'paragraph':
            return bare
          case 'heading':
            return `${'#'.repeat(clamp(input.level ?? 2, 1, 6))} ${bare}`
          case 'bullet_list':
            return `- ${bare}`
          case 'ordered_list':
            return `${i + 1}. ${bare}`
          default:
            throw new Error(`Unsupported block format: ${input.format}`)
        }
      })
      const end = this.spliceText(bounds.start, bounds.end, transformed.join('\n'))
      this.selection = { from: bounds.start, to: end }
      this.cursor = end
    }
    this.completedMutations.push({ kind: 'set_format', formatKind: input.kind, format: input.format, action })
    return { ok: true, kind: input.kind, format: input.format, action }
  }

  insertText(text: string, _contentFormat: ContentFormat = 'markdown'): { ok: true; insertedChars: number } {
    this.throwIfAborted()
    const selection = this.resolveSelection()
    if (selection) {
      this.cursor = this.spliceText(selection.from, selection.to, text)
      this.selection = null
    } else {
      this.cursor = this.spliceText(this.cursor, this.cursor, text)
    }
    if (text.length > 0) this.completedMutations.push({ kind: 'insert_text', insertedChars: text.length })
    return { ok: true, insertedChars: text.length }
  }

  replaceMatches(
    matchIds: string[],
    text: string,
    _contentFormat: ContentFormat = 'markdown',
  ): { ok: true; replacedCount: number; insertedChars: number } {
    this.throwIfAborted()
    const uniqueIds = Array.from(new Set(matchIds))
    if (uniqueIds.length === 0) return { ok: true, replacedCount: 0, insertedChars: text.length }

    // Resolve all ranges against current text, apply right-to-left.
    const ranges = uniqueIds.map((id) => {
      const handle = this.matches.get(id)
      if (!handle) throw new Error(`Unknown matchId: ${id}`)
      return this.resolveMatch(handle)
    })
    ranges.sort((a, b) => (a.from === b.from ? b.to - a.to : b.from - a.from))
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i - 1]!.from < ranges[i]!.to) {
        throw new Error('replace_matches received overlapping match ranges')
      }
    }

    let cursorPos = ranges[ranges.length - 1]!.from
    for (const range of ranges) {
      cursorPos = this.spliceText(range.from, range.to, text)
    }
    this.selection = null
    this.cursor = cursorPos
    this.completedMutations.push({ kind: 'replace_matches', replacedCount: ranges.length, insertedChars: text.length })
    return { ok: true, replacedCount: ranges.length, insertedChars: text.length }
  }

  deleteSelection(): { ok: true; deleted: boolean } {
    this.throwIfAborted()
    const selection = this.resolveSelection()
    if (!selection) return { ok: true, deleted: false }
    this.cursor = this.spliceText(selection.from, selection.to, '')
    this.selection = null
    this.completedMutations.push({ kind: 'delete_selection' })
    return { ok: true, deleted: true }
  }

  // ── streaming edits ───────────────────────────────────────────────────

  startStreamingEdit(
    mode: AgentRunMode,
    contentFormat: ContentFormat = 'markdown',
  ): { ok: true; editSessionId: string; mode: AgentRunMode; contentFormat: ContentFormat } {
    this.throwIfAborted()
    if (this.activeEdit) throw new Error('A streaming edit is already active')

    const originalText = this.text()
    let before: string
    let after: string
    let deletedSelectionText: string | undefined

    if (mode === 'rewrite') {
      const selection = this.resolveSelection()
      if (!selection) throw new Error('Rewrite requires an active selection')
      before = originalText.slice(0, selection.from)
      after = originalText.slice(selection.to)
      deletedSelectionText = originalText.slice(selection.from, selection.to)
      this.selection = null
    } else if (mode === 'continue') {
      before = originalText
      after = ''
    } else {
      const at = clamp(this.cursor, 0, originalText.length)
      before = originalText.slice(0, at)
      after = originalText.slice(at)
      this.selection = null
    }

    // Separate appended/inserted prose from preceding content with a blank line
    // so block markers (headings, {% ... %}, tables) start on their own line.
    if ((mode === 'continue' || mode === 'insert') && before.length > 0 && !before.endsWith('\n\n')) {
      before += before.endsWith('\n') ? '\n' : '\n\n'
    }

    this.activeEdit = {
      id: `edit${++MATCH_SEQ}`,
      mode,
      contentFormat,
      before,
      after,
      buffer: '',
      originalText,
      committedChars: 0,
      deletedSelectionText,
    }
    this.session.setStatus('thinking')
    this.session.setTail(null)
    this.broadcastCursorAtMarkdownPrefix(before)
    return { ok: true, editSessionId: this.activeEdit.id, mode, contentFormat }
  }

  isStreamingEditActive(): boolean {
    return this.activeEdit !== null
  }

  getActiveStreamingEditInfo(): { mode: AgentRunMode; contentFormat: ContentFormat } | null {
    if (!this.activeEdit) return null
    return { mode: this.activeEdit.mode, contentFormat: this.activeEdit.contentFormat }
  }

  hasStreamingEditGenerator(): boolean {
    return this.streamingEditGenerator !== undefined
  }

  async driveStreamingEditContent(
    emitter: StreamingEditEventEmitter,
  ): Promise<{ ok: true; committedChars: number; cancelled?: boolean }> {
    const edit = this.activeEdit
    const generator = this.streamingEditGenerator
    if (!edit || !generator) return { ok: true, committedChars: 0 }
    const messageId = edit.id
    const { mode, contentFormat } = edit
    emitter.start({ messageId, mode, contentFormat })
    try {
      const stream = generator({
        mode,
        contentFormat,
        documentContext: this.getDocumentSnapshot().text,
        ...(edit.deletedSelectionText ? { selectionText: edit.deletedSelectionText } : {}),
        signal: this.signal,
      })
      // Throttle document writes to a steady cadence instead of per-token. Each
      // write rewrites the whole fragment and republishes the agent cursor; doing
      // that per-token churns Yjs items and races the cursor (awareness) ahead of
      // the doc update, so the caret/edits render inconsistently. Coalescing gives
      // the doc + cursor time to sync together.
      let lastFlush = 0
      for await (const delta of stream) {
        this.throwIfAborted()
        if (delta.length === 0) continue
        edit.buffer += delta
        emitter.delta({ messageId, delta })
        const now = Date.now()
        if (now - lastFlush >= STREAM_FLUSH_MS) {
          lastFlush = now
          this.flushStreamingEdit()
        }
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError'
      const result = this.stopStreamingEdit(cancelled)
      emitter.end({
        messageId,
        committedChars: result.committedChars,
        ...(result.cancelled ? { cancelled: true } : {}),
      })
      if (cancelled) return result
      throw error
    }
    const result = this.stopStreamingEdit(false)
    emitter.end({ messageId, committedChars: result.committedChars })
    return result
  }

  /**
   * Accumulate a streamed markdown delta and flush immediately. Used by tests and
   * manual callers; the server drive loop accumulates and flushes on a throttle.
   */
  async pushStreamingText(delta: string): Promise<void> {
    this.throwIfAborted()
    const edit = this.activeEdit
    if (!edit || delta.length === 0) return
    edit.buffer += delta
    this.flushStreamingEdit()
  }

  /**
   * Re-render the whole document as `before + buffer + after` and republish the
   * agent caret. Rebuilding from stable segments (not splicing into the
   * re-serialized fragment) keeps the AI's raw markdown intact so tables/code
   * parse correctly once complete and characters never drift.
   */
  private flushStreamingEdit(): void {
    const edit = this.activeEdit
    if (!edit) return
    this.write(edit.before + edit.buffer + edit.after)
    edit.committedChars = edit.buffer.length
    this.cursor = edit.before.length + edit.buffer.length
    this.session.setStatus('composing')
    this.broadcastCursorAtMarkdownPrefix(edit.before + edit.buffer)
  }

  /** Place the agent caret at the ProseMirror position matching a markdown prefix. */
  private broadcastCursorAtMarkdownPrefix(prefix: string): void {
    try {
      const { doc, mapping } = fragmentMapping(this.session.fragment)
      // Target just INSIDE the content (content.size - 1), not the very end:
      // a position exactly at content.size yields a rootless relative position
      // that resolves to null on the client, so no caret renders. One before the
      // boundary lands inside the last text node → a concrete, resolvable anchor.
      const maxPos = Math.max(0, doc.content.size - 1)
      const pmPos = Math.max(0, Math.min(pmSizeForMarkdown(prefix), maxPos))
      this.session.setCursorAt(pmPos, mapping)
    } catch {
      // Best-effort: a missing caret shouldn't break the edit.
    }
  }

  stopStreamingEdit(cancelled: boolean = false): { ok: true; committedChars: number; cancelled?: boolean } {
    const edit = this.activeEdit
    if (!edit) return { ok: true, committedChars: 0, cancelled }

    if (cancelled) {
      // Revert to the document as it was before the edit started.
      this.write(edit.originalText)
    } else {
      // Always write the final, complete markdown (throttling may have skipped
      // the last delta's flush).
      this.write(edit.before + edit.buffer + edit.after)
      edit.committedChars = edit.buffer.length
    }

    const result = {
      ok: true as const,
      committedChars: edit.committedChars,
      ...(cancelled ? { cancelled: true } : {}),
    }
    if (edit.committedChars > 0) {
      this.completedMutations.push({
        kind: 'streaming_edit',
        mode: edit.mode,
        contentFormat: edit.contentFormat,
        committedChars: edit.committedChars,
        ...(cancelled ? { cancelled: true } : {}),
      })
    }
    this.activeEdit = null
    this.session.setTail(null)
    this.session.setStatus('idle')
    this.session.clearCursor()
    return result
  }

  async destroy(): Promise<void> {
    this.session.clearCursor()
    this.session.setTail(null)
    this.session.setStatus('idle')
    await this.session.destroy()
  }
}
