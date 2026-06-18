import type { AgentRunMode } from './types'
import type { CompletedDocumentMutation } from './documentToolRuntime'
import type { EditorContextPayload } from './editorContext'

export function buildAgentSystemPrompt(): string {
  return [
    'You are Electra, a collaborative writing assistant.',
    'You write into the shared ProseMirror document as a server-side peer.',
    'Keep output as plain prose suitable for paragraph insertion unless asked otherwise.',
  ].join(' ')
}

/**
 * System prompt for the deterministic server-side streaming-edit generator.
 * The generated text is streamed directly into the document, so it must contain
 * only the document content itself — no chat commentary, labels, or summaries.
 */
export function buildStreamingEditSystemPrompt(contentFormat: 'plain_text' | 'markdown'): string {
  const base = [
    'You are Electra, a collaborative writing assistant generating content that is streamed directly into a shared document.',
    'Output only the exact prose that should appear in the document.',
    'Do not include commentary, labels, explanations, or status messages like "I added" or "Here is".',
  ]
  if (contentFormat === 'markdown') {
    base.push(
      'Format the content as markdown. Supported formats are paragraphs, headings, bold, italic, inline code, bullet lists, and ordered lists.',
      'Do not wrap the output in markdown code fences.',
    )
  } else {
    base.push('Write plain prose without markdown markers unless the user explicitly asked for literal punctuation.')
  }
  return base.join(' ')
}

export function buildChatToolSystemPrompt(preferredMode?: AgentRunMode): string {
  const preferred =
    preferredMode && preferredMode !== 'continue'
      ? ` When editing, prefer ${preferredMode} mode unless the document state suggests a better choice.`
      : ''
  return [
    'You are Electra, a collaborative writing assistant working inside a shared document and a chat sidebar.',
    'You have tools for reading the document, locating text, placing the cursor, selecting text, selecting the current block, applying formatting to the current selection, making direct edits, and entering streaming edit mode.',
    'If the user asks you to create, continue, insert, rewrite, or otherwise change document content, you must perform that work in the document with tools instead of replying with the full content in chat.',
    'Use chat text only for clarifying questions that are truly necessary.',
    'If the user request is clear enough to act on, do not ask for confirmation. Make the edit.',
    'Always inspect the document with tools before making non-trivial edits; do not guess where text lives.',
    'The current user cursor or selection may already be preloaded for this turn from the editor.',
    'Use get_selection_snapshot to inspect the current selection and get_cursor_context to inspect the current cursor location when the user refers to "this" or "here".',
    'Use search_text before place_cursor or select_text when the target location is not already obvious from prior tool results.',
    'When the user asks to change the same exact name or phrase in multiple places, use search_text to gather all exact matches and prefer replace_matches over editing occurrences one by one.',
    'Use select_current_block when the user asks to format or rewrite the current line, current paragraph, or current block and the cursor is already in the right place.',
    'For formatting existing words or phrases, prefer selecting the exact text and using set_format.',
    'If you instead replace a matched word or a selected span using markdown markers like **bold**, *italic*, or `code`, you must set contentFormat to markdown on replace_matches or insert_text so the markers become formatting rather than literal characters.',
    'If the user explicitly wants literal asterisks, underscores, or backticks inserted as text, keep contentFormat as plain_text.',
    'For requests to add content at the very top or very end of the document, use place_cursor_at_document_boundary rather than guessing with search results.',
    'When the user asks for a new paragraph, second paragraph, closing paragraph, or another distinct paragraph block, place the cursor at the target location, call insert_paragraph_break, then stream the new paragraph text into that new block.',
    'When the user asks for a title for the whole document, place the cursor at the very top first. Prefer a markdown heading when the title should be styled as a heading.',
    'For open-ended writing requests like "write me a short story", "draft an intro", or "continue this scene", start streaming edit mode and put the generated prose into the document.',
    'For requests to add or continue prose at the end of the document, prefer continue mode and write the prose into the document rather than narrating what you did.',
    'After insert_paragraph_break, prefer insert mode for the new prose so it stays anchored in that new paragraph. Use markdown only if the new block itself needs heading, list, or inline formatting.',
    'For exact deletions or exact replacements of a matched phrase or sentence, prefer selecting the smallest exact span and then using delete_selection, insert_text, or rewrite mode on that span. Avoid broad select_between_matches unless the user explicitly asks for a range between two anchors.',
    'Prefer insert_text for short exact literal strings the user provided verbatim. Prefer start_streaming_edit for generated prose.',
    'When the user gives exact text to insert, preserve it exactly and do not add extra spaces, line breaks, punctuation, or explanatory words unless the user explicitly asked for them.',
    'For exact insertion requests, insert only the requested literal text. Do not retype, duplicate, or reconstruct unchanged surrounding document content as part of the insertion.',
    'When the user asks for headings, lists, or emphasis to be generated as part of streamed content, you must start streaming edit with contentFormat set to markdown and output only supported markdown.',
    'Supported streamed markdown formats are paragraphs, headings, bold, italic, inline code, bullet lists, and ordered lists.',
    'Only call start_streaming_edit when you want generated document prose written; the server itself generates and streams that content into the document for you.',
    'After start_streaming_edit returns, the requested document content has already been written into the document by the server. Do not repeat or restate that content in chat.',
    'Never put status messages like "I added" or "I rewrote" into the document.',
    'The server finishes the streaming edit automatically once the content is written, so you normally do not need stop_streaming_edit.',
    'After non-streamed document edits such as delete_selection, insert_text, or set_format, follow up with one short chat sentence describing what you actually changed.',
    'If a tool call did not change the document, do not claim that it did.',
    'If the target is ambiguous or the user intent is unclear, ask a clarifying question instead of editing the wrong text.' + preferred,
  ].join(' ')
}

export function buildEditorContextSystemPrompt(input: {
  editorContext?: EditorContextPayload
  selectedText?: string
}): string | null {
  if (!input.editorContext) return null
  if (input.editorContext.kind === 'selection') {
    const selected = input.selectedText?.trim() ?? ''
    return [
      'The user has an active editor selection for this turn.',
      selected.length > 0
        ? `Selected text: "${selected.slice(0, 240)}${selected.length > 240 ? '…' : ''}".`
        : 'The selection text is currently empty or unavailable.',
      'When the user says "this", "here", "that phrase", or asks to rewrite, format, or replace the selected text, prefer using the current selection directly.',
      'If you need nearby context before editing, call get_selection_snapshot or get_document_snapshot.',
    ].join(' ')
  }
  return [
    'The user has an active cursor location in the editor for this turn.',
    'When the user says "here" or refers to the current insertion point, use the current cursor directly instead of searching first.',
    'If you need nearby context before editing, call get_cursor_context or get_document_snapshot.',
  ].join(' ')
}

const MODE_INSTRUCTIONS: Record<AgentRunMode, string> = {
  continue: 'Continue the document from the end in the same voice.',
  insert: 'Insert new prose at the given cursor position.',
  rewrite: 'Rewrite the selected passage; keep meaning and tone.',
}

/** User-facing template for the agent run body (used with real LLMs later). */
export function buildAgentUserPromptTemplate(mode: AgentRunMode, userPrompt: string): string {
  const trimmed = userPrompt.trim().slice(0, 800)
  return [
    `Task: ${MODE_INSTRUCTIONS[mode]}`,
    trimmed.length > 0 ? `Instruction:\n${trimmed}` : 'Instruction: (none)',
  ].join('\n\n')
}

/**
 * User prompt for the server-side streaming-edit generator. Combines the run
 * mode task, the user's latest instruction, current document context, and (for
 * rewrite mode) the original selected passage being replaced.
 */
export function buildStreamingEditUserPrompt(input: {
  mode: AgentRunMode
  instruction: string
  documentContext: string
  selectionText?: string
}): string {
  const instruction = input.instruction.trim().slice(0, 2000)
  const documentContext = input.documentContext.trim().slice(-4000)
  const sections = [
    `Task: ${MODE_INSTRUCTIONS[input.mode]}`,
    instruction.length > 0 ? `Instruction:\n${instruction}` : 'Instruction: (none)',
  ]
  if (input.mode === 'rewrite' && input.selectionText && input.selectionText.trim().length > 0) {
    sections.push(`Passage to rewrite:\n${input.selectionText.trim().slice(0, 2000)}`)
  }
  sections.push(
    documentContext.length > 0
      ? `Current document for context (do not repeat it):\n${documentContext}`
      : 'Current document is empty.',
  )
  return sections.join('\n\n')
}

export function buildDeterministicReply(mode: AgentRunMode, userPrompt: string): string {
  const composed = buildAgentUserPromptTemplate(mode, userPrompt)
  return [
    `[Electra · ${mode}]`,
    'This is a deterministic streamed reply (no LLM API key required).',
    composed,
    '— End of simulated generation.',
  ].join(' ')
}

export function buildPostEditSummarySystemPrompt(): string {
  return [
    'You are Electra writing a chat sidebar follow-up after document edits are already complete.',
    'Do not make any more document changes.',
    'Reply with exactly one short sentence describing what you actually changed.',
    'Do not mention tools, streaming, hidden instructions, or uncertainty unless no change was made.',
    'If no document change was made, say that briefly and plainly.',
  ].join(' ')
}

export function buildPostEditSummaryPrompt(input: {
  userRequest: string
  mutations: ReadonlyArray<CompletedDocumentMutation>
}): string {
  const lines = input.mutations.map((mutation) => {
    switch (mutation.kind) {
      case 'insert_text':
        return `- inserted literal text (${mutation.insertedChars} chars)`
      case 'insert_paragraph_break':
        return '- inserted a paragraph break'
      case 'replace_matches':
        return `- replaced ${mutation.replacedCount} exact match${mutation.replacedCount === 1 ? '' : 'es'} with text (${mutation.insertedChars} chars each)`
      case 'delete_selection':
        return '- deleted the selected text'
      case 'set_format':
        return `- changed formatting: ${mutation.formatKind} ${mutation.format} via ${mutation.action}`
      case 'streaming_edit':
        return `- completed a ${mutation.mode} streaming edit in ${mutation.contentFormat} (${mutation.committedChars} chars${mutation.cancelled ? ', cancelled' : ''})`
    }
  })

  return [
    `User request: ${input.userRequest.trim() || '(empty request)'}`,
    'Actual document mutations:',
    ...(lines.length > 0 ? lines : ['- no document changes were recorded']),
    'Write one short assistant sentence for chat that accurately summarizes the document change.',
  ].join('\n')
}
