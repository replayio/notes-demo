import type { YjsProvider } from '@durable-streams/y-durable-streams'
import { encodeAnchor, decodeAnchor, decodeAnchorBase64, bytesToBase64Str } from './markdownAnchors'
import {
  createAgentTransactionOrigin,
  createServerAgentSession,
  type ServerAgentSession,
} from './serverAgentSession'
import type { AgentRunMode, AgentTransactionOrigin } from './types'
import type { EditorContextPayload } from './editorContext'

/**
 * Server-side editing runtime. The document is a single `Y.Text` holding GitBook
 * markdown, so every operation here is a string edit (insert / delete / replace)
 * on that text, with positions anchored as Yjs relative positions so they stay
 * stable across concurrent edits.
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

/** Expand [from,to] to the full lines they touch. */
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
  startAnchorB64: string
  endAnchorB64: string
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
  /** For rewrite mode: the original selected passage being replaced. */
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

interface ActiveStreamingEdit {
  id: string
  mode: AgentRunMode
  contentFormat: ContentFormat
  insertAnchorBytes?: Uint8Array
  committedChars: number
  deletedSelectionText?: string
}

const MARK_DELIMITER: Record<'bold' | 'italic' | 'code', string> = {
  bold: '**',
  italic: '*',
  code: '`',
}

export class DocumentToolRuntime {
  private readonly origin: AgentTransactionOrigin
  private cursorAnchorBytes: Uint8Array | undefined
  private selectionStartBytes: Uint8Array | undefined
  private selectionEndBytes: Uint8Array | undefined
  private readonly matches = new Map<string, SearchMatchResult>()
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
    runtime.applyEditorContext(input.editorContext)
    runtime.ensureCursorAtEnd()
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
    runtime.applyEditorContext(input.editorContext)
    runtime.ensureCursorAtEnd()
    input.session.setStatus('idle')
    return runtime
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new DOMException('Agent run aborted', 'AbortError')
    }
  }

  // ── primitive text ops ────────────────────────────────────────────────

  private text(): string {
    return this.session.text.toString()
  }

  private len(): number {
    return this.session.text.length
  }

  private insertAt(offset: number, str: string): number {
    if (!str) return offset
    const at = clamp(offset, 0, this.len())
    this.session.ydoc.transact(() => {
      this.session.text.insert(at, str)
    }, this.origin)
    return at + str.length
  }

  private replaceRange(from: number, to: number, str: string): number {
    const range = normalizeRange(clamp(from, 0, this.len()), clamp(to, 0, this.len()))
    this.session.ydoc.transact(() => {
      if (range.to > range.from) this.session.text.delete(range.from, range.to - range.from)
      if (str) this.session.text.insert(range.from, str)
    }, this.origin)
    return range.from + str.length
  }

  private deleteRange(from: number, to: number): number {
    const range = normalizeRange(clamp(from, 0, this.len()), clamp(to, 0, this.len()))
    if (range.to > range.from) {
      this.session.ydoc.transact(() => {
        this.session.text.delete(range.from, range.to - range.from)
      }, this.origin)
    }
    return range.from
  }

  private anchorAt(offset: number): Uint8Array {
    return encodeAnchor(this.session.text, clamp(offset, 0, this.len()))
  }

  private resolve(bytes: Uint8Array | undefined): number | null {
    if (!bytes) return null
    return decodeAnchor(this.session.ydoc, bytes)
  }

  // ── cursor / selection ────────────────────────────────────────────────

  getCompletedMutations(): ReadonlyArray<CompletedDocumentMutation> {
    return this.completedMutations
  }

  getCompletedMutationCount(): number {
    return this.completedMutations.length
  }

  private ensureCursorAtEnd(): void {
    const current = this.resolve(this.cursorAnchorBytes)
    if (current !== null) {
      this.session.setCursorFromIndex(current)
      return
    }
    const end = this.len()
    this.cursorAnchorBytes = this.anchorAt(end)
    this.session.setCursorFromIndex(end)
  }

  private applyEditorContext(editorContext: EditorContextPayload | undefined): void {
    if (!editorContext) return
    if (editorContext.kind === 'selection') {
      const startBytes = decodeAnchorBase64(editorContext.anchor)
      const endBytes = decodeAnchorBase64(editorContext.head)
      const start = this.resolve(startBytes)
      const end = this.resolve(endBytes)
      if (start === null || end === null) return
      this.selectionStartBytes = startBytes
      this.selectionEndBytes = endBytes
      this.cursorAnchorBytes = endBytes
      this.session.setCursorFromIndex(Math.max(start, end))
      return
    }
    const cursorBytes = decodeAnchorBase64(editorContext.anchor)
    const cursorPos = this.resolve(cursorBytes)
    if (cursorPos === null) return
    this.clearSelectionInternal()
    this.cursorAnchorBytes = cursorBytes
    this.session.setCursorFromIndex(cursorPos)
  }

  private updateCursor(offset: number): void {
    this.cursorAnchorBytes = this.anchorAt(offset)
    this.session.setCursorFromIndex(offset)
  }

  private resolveSelection(): { from: number; to: number } | null {
    const from = this.resolve(this.selectionStartBytes)
    const to = this.resolve(this.selectionEndBytes)
    if (from === null || to === null) return null
    return normalizeRange(from, to)
  }

  private clearSelectionInternal(): void {
    this.selectionStartBytes = undefined
    this.selectionEndBytes = undefined
  }

  // ── reads ─────────────────────────────────────────────────────────────

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
    this.ensureCursorAtEnd()
    const pos = this.resolve(this.cursorAnchorBytes)
    if (pos === null) return null
    const s = this.text()
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
      const handle: SearchMatchResult = {
        matchId: crypto.randomUUID(),
        text: trimmed,
        ...preview(s, found, trimmed.length),
        startAnchorB64: bytesToBase64Str(this.anchorAt(found)),
        endAnchorB64: bytesToBase64Str(this.anchorAt(found + trimmed.length)),
      }
      this.matches.set(handle.matchId, handle)
      results.push(handle)
      fromIndex = found + Math.max(1, trimmed.length)
    }
    return results
  }

  // ── cursor placement / selection ──────────────────────────────────────

  placeCursor(matchId: string, edge: 'start' | 'end' = 'start'): { ok: true; cursorAnchorB64: string } {
    const handle = this.matches.get(matchId)
    if (!handle) throw new Error(`Unknown matchId: ${matchId}`)
    const bytes = decodeAnchorBase64(edge === 'start' ? handle.startAnchorB64 : handle.endAnchorB64)
    const pos = this.resolve(bytes)
    if (pos === null) throw new Error('Could not resolve cursor target')
    this.cursorAnchorBytes = bytes
    this.clearSelectionInternal()
    this.session.setCursorFromIndex(pos)
    return { ok: true, cursorAnchorB64: bytesToBase64Str(bytes) }
  }

  placeCursorAtDocumentBoundary(
    boundary: 'start' | 'end',
  ): { ok: true; cursorAnchorB64: string; boundary: 'start' | 'end' } {
    const pos = boundary === 'start' ? 0 : this.len()
    this.cursorAnchorBytes = this.anchorAt(pos)
    this.clearSelectionInternal()
    this.session.setCursorFromIndex(pos)
    return { ok: true, cursorAnchorB64: bytesToBase64Str(this.cursorAnchorBytes), boundary }
  }

  selectText(matchId: string): { ok: true; selectedText: string } {
    const handle = this.matches.get(matchId)
    if (!handle) throw new Error(`Unknown matchId: ${matchId}`)
    this.selectionStartBytes = decodeAnchorBase64(handle.startAnchorB64)
    this.selectionEndBytes = decodeAnchorBase64(handle.endAnchorB64)
    this.cursorAnchorBytes = this.selectionEndBytes
    const pos = this.resolve(this.selectionEndBytes)
    if (pos !== null) this.session.setCursorFromIndex(pos)
    return { ok: true, selectedText: handle.text }
  }

  selectCurrentBlock(): { ok: true; selectedText: string } {
    this.ensureCursorAtEnd()
    const cursorPos = this.resolve(this.cursorAnchorBytes)
    if (cursorPos === null) throw new Error('Could not resolve cursor position')
    const s = this.text()
    const { start, end } = lineBounds(s, cursorPos, cursorPos)
    this.selectionStartBytes = this.anchorAt(start)
    this.selectionEndBytes = this.anchorAt(end)
    this.cursorAnchorBytes = this.selectionEndBytes
    this.session.setCursorFromIndex(end)
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
    const startBytes = decodeAnchorBase64(
      startEdge === 'start' ? startHandle.startAnchorB64 : startHandle.endAnchorB64,
    )
    const endBytes = decodeAnchorBase64(
      endEdge === 'start' ? endHandle.startAnchorB64 : endHandle.endAnchorB64,
    )
    const startAbs = this.resolve(startBytes)
    const endAbs = this.resolve(endBytes)
    if (startAbs === null || endAbs === null) throw new Error('Could not resolve selection range')
    const range = normalizeRange(startAbs, endAbs)
    this.selectionStartBytes = this.anchorAt(range.from)
    this.selectionEndBytes = this.anchorAt(range.to)
    this.cursorAnchorBytes = this.selectionEndBytes
    this.session.setCursorFromIndex(range.to)
    return { ok: true }
  }

  clearSelection(): { ok: true } {
    this.clearSelectionInternal()
    this.ensureCursorAtEnd()
    return { ok: true }
  }

  // ── edits ─────────────────────────────────────────────────────────────

  insertParagraphBreak(): { ok: true } {
    this.throwIfAborted()
    this.ensureCursorAtEnd()
    const pos = this.resolve(this.cursorAnchorBytes)
    if (pos === null) throw new Error('Could not resolve cursor position')
    const endPos = this.insertAt(pos, '\n\n')
    this.clearSelectionInternal()
    this.completedMutations.push({ kind: 'insert_paragraph_break' })
    this.updateCursor(endPos)
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
      const alreadyWrapped = inner.startsWith(delim) && inner.endsWith(delim) && inner.length >= delim.length * 2
      const shouldRemove = action === 'remove' || (action === 'toggle' && alreadyWrapped)
      const next = shouldRemove
        ? inner.slice(delim.length, inner.length - delim.length)
        : `${delim}${inner}${delim}`
      const endPos = this.replaceRange(selection.from, selection.to, next)
      this.selectionStartBytes = this.anchorAt(selection.from)
      this.selectionEndBytes = this.anchorAt(endPos)
      this.cursorAnchorBytes = this.selectionEndBytes
      this.session.setCursorFromIndex(endPos)
      this.completedMutations.push({ kind: 'set_format', formatKind: input.kind, format: input.format, action })
      return { ok: true, kind: input.kind, format: input.format, action }
    }

    // Block formatting: rewrite the whole lines the selection touches.
    const bounds = lineBounds(s, selection.from, selection.to)
    const block = s.slice(bounds.start, bounds.end)
    const lines = block.split('\n')
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
    const next = transformed.join('\n')
    const endPos = this.replaceRange(bounds.start, bounds.end, next)
    this.selectionStartBytes = this.anchorAt(bounds.start)
    this.selectionEndBytes = this.anchorAt(endPos)
    this.cursorAnchorBytes = this.selectionEndBytes
    this.session.setCursorFromIndex(endPos)
    this.completedMutations.push({ kind: 'set_format', formatKind: input.kind, format: input.format, action })
    return { ok: true, kind: input.kind, format: input.format, action }
  }

  insertText(
    text: string,
    _contentFormat: ContentFormat = 'markdown',
  ): { ok: true; insertedChars: number } {
    this.throwIfAborted()
    const selection = this.resolveSelection()
    let endPos: number
    if (selection) {
      endPos = this.replaceRange(selection.from, selection.to, text)
      this.clearSelectionInternal()
    } else {
      this.ensureCursorAtEnd()
      const pos = this.resolve(this.cursorAnchorBytes)
      if (pos === null) throw new Error('Could not resolve cursor position')
      endPos = this.insertAt(pos, text)
    }
    this.updateCursor(endPos)
    if (text.length > 0) this.completedMutations.push({ kind: 'insert_text', insertedChars: text.length })
    return { ok: true, insertedChars: text.length }
  }

  replaceMatches(
    matchIds: string[],
    text: string,
    _contentFormat: ContentFormat = 'markdown',
  ): { ok: true; replacedCount: number; insertedChars: number } {
    this.throwIfAborted()
    const uniqueMatchIds = Array.from(new Set(matchIds))
    if (uniqueMatchIds.length === 0) return { ok: true, replacedCount: 0, insertedChars: text.length }

    const ranges = uniqueMatchIds.map((matchId) => {
      const handle = this.matches.get(matchId)
      if (!handle) throw new Error(`Unknown matchId: ${matchId}`)
      const start = this.resolve(decodeAnchorBase64(handle.startAnchorB64))
      const end = this.resolve(decodeAnchorBase64(handle.endAnchorB64))
      if (start === null || end === null) throw new Error(`Could not resolve matchId: ${matchId}`)
      return normalizeRange(start, end)
    })

    // Apply right-to-left so earlier offsets remain valid.
    ranges.sort((a, b) => (a.from === b.from ? b.to - a.to : b.from - a.from))
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i - 1]!.from < ranges[i]!.to) {
        throw new Error('replace_matches received overlapping match ranges')
      }
    }

    let cursorPos = ranges[ranges.length - 1]!.from
    for (const range of ranges) {
      cursorPos = this.replaceRange(range.from, range.to, text)
    }

    this.clearSelectionInternal()
    this.updateCursor(cursorPos)
    this.completedMutations.push({
      kind: 'replace_matches',
      replacedCount: ranges.length,
      insertedChars: text.length,
    })
    return { ok: true, replacedCount: ranges.length, insertedChars: text.length }
  }

  deleteSelection(): { ok: true; deleted: boolean } {
    this.throwIfAborted()
    const selection = this.resolveSelection()
    if (!selection) return { ok: true, deleted: false }
    const endPos = this.deleteRange(selection.from, selection.to)
    this.clearSelectionInternal()
    this.updateCursor(endPos)
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
    let insertOffset: number
    let deletedSelectionText: string | undefined

    if (mode === 'rewrite') {
      const selection = this.resolveSelection()
      if (!selection) throw new Error('Rewrite requires an active selection')
      deletedSelectionText = this.text().slice(selection.from, selection.to)
      insertOffset = this.deleteRange(selection.from, selection.to)
      this.clearSelectionInternal()
    } else if (mode === 'continue') {
      insertOffset = this.len()
    } else {
      this.ensureCursorAtEnd()
      const pos = this.resolve(this.cursorAnchorBytes)
      insertOffset = pos ?? this.len()
      this.clearSelectionInternal()
    }

    // Separate appended prose from preceding content with a blank line.
    if ((mode === 'continue' || mode === 'insert') && insertOffset > 0) {
      const before = this.text().slice(0, insertOffset)
      if (!before.endsWith('\n\n')) {
        const sep = before.endsWith('\n') ? '\n' : '\n\n'
        insertOffset = this.insertAt(insertOffset, sep)
      }
    }

    this.cursorAnchorBytes = this.anchorAt(insertOffset)
    this.session.setCursorFromIndex(insertOffset)
    this.activeEdit = {
      id: crypto.randomUUID(),
      mode,
      contentFormat,
      insertAnchorBytes: this.anchorAt(insertOffset),
      committedChars: 0,
      deletedSelectionText,
    }
    this.session.setStatus('thinking')
    this.session.setTail(null)
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
      for await (const delta of stream) {
        this.throwIfAborted()
        if (delta.length === 0) continue
        await this.pushStreamingText(delta)
        emitter.delta({ messageId, delta })
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

  /** Append a streamed markdown delta into the document at the live insert anchor. */
  async pushStreamingText(delta: string): Promise<void> {
    this.throwIfAborted()
    const edit = this.activeEdit
    if (!edit || delta.length === 0) return
    const pos = this.resolve(edit.insertAnchorBytes) ?? this.len()
    const endPos = this.insertAt(pos, delta)
    edit.insertAnchorBytes = this.anchorAt(endPos)
    edit.committedChars += delta.length
    this.session.setStatus('composing')
    this.updateCursor(endPos)
  }

  stopStreamingEdit(cancelled: boolean = false): { ok: true; committedChars: number; cancelled?: boolean } {
    const edit = this.activeEdit
    if (!edit) return { ok: true, committedChars: 0, cancelled }

    // On cancel with nothing written, restore a rewrite's original passage.
    if (cancelled && edit.committedChars === 0 && edit.deletedSelectionText && edit.insertAnchorBytes) {
      const pos = this.resolve(edit.insertAnchorBytes)
      if (pos !== null) this.updateCursor(this.insertAt(pos, edit.deletedSelectionText))
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
    return result
  }

  async destroy(): Promise<void> {
    this.session.clearCursor()
    this.session.setTail(null)
    this.session.setStatus('idle')
    await this.session.destroy()
  }
}
