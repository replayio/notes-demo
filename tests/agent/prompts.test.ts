import { describe, expect, it } from 'vitest'
import {
  buildAgentSystemPrompt,
  buildEditorContextSystemPrompt,
  buildAgentUserPromptTemplate,
  buildChatToolSystemPrompt,
  buildDeterministicReply,
  buildPostEditSummaryPrompt,
  buildPostEditSummarySystemPrompt,
  buildStreamingEditSystemPrompt,
  buildStreamingEditUserPrompt,
} from '../../src/lib/agent/prompts'

describe('prompt unit tests', () => {
  it('builds the base agent system prompt', () => {
    const prompt = buildAgentSystemPrompt()

    expect(prompt).toContain('Electra')
    expect(prompt).toContain('shared ProseMirror document')
    expect(prompt).toContain('plain prose suitable for paragraph insertion')
  })

  it('builds chat tool prompts for default and preferred modes', () => {
    const defaultPrompt = buildChatToolSystemPrompt()
    const insertPrompt = buildChatToolSystemPrompt('insert')
    const rewritePrompt = buildChatToolSystemPrompt('rewrite')

    expect(defaultPrompt).toContain('must perform that work in the document with tools')
    expect(defaultPrompt).toContain('write me a short story')
    expect(defaultPrompt).toContain('Only call start_streaming_edit')
    expect(defaultPrompt).toContain('current user cursor or selection may already be preloaded')
    expect(defaultPrompt).toContain('Use get_selection_snapshot to inspect the current selection')
    expect(defaultPrompt).toContain('follow up with one short chat sentence describing what you actually changed')
    expect(defaultPrompt).toContain('If a tool call did not change the document, do not claim that it did')
    expect(defaultPrompt).toContain('For formatting existing words or phrases, prefer selecting the exact text and using set_format')
    expect(defaultPrompt).toContain('you must set contentFormat to markdown on replace_matches or insert_text')
    expect(defaultPrompt).toContain('When the user asks for a new paragraph, second paragraph, closing paragraph')
    expect(defaultPrompt).toContain('call insert_paragraph_break')
    expect(defaultPrompt).toContain('After insert_paragraph_break, prefer insert mode')
    expect(insertPrompt).toContain('prefer insert mode')
    expect(rewritePrompt).toContain('prefer rewrite mode')
  })

  it('builds user prompt templates for each mode', () => {
    expect(buildAgentUserPromptTemplate('continue', 'Keep going')).toContain(
      'Task: Continue the document from the end in the same voice.',
    )
    expect(buildAgentUserPromptTemplate('insert', 'Add a paragraph')).toContain(
      'Task: Insert new prose at the given cursor position.',
    )
    expect(buildAgentUserPromptTemplate('rewrite', 'Make it shorter')).toContain(
      'Task: Rewrite the selected passage; keep meaning and tone.',
    )
  })

  it('trims overly long user prompts and handles empty input', () => {
    const long = `  ${'x'.repeat(900)}  `
    const trimmed = buildAgentUserPromptTemplate('continue', long)
    const empty = buildAgentUserPromptTemplate('continue', '   ')

    expect(trimmed).toContain(`Instruction:\n${'x'.repeat(800)}`)
    expect(trimmed).not.toContain('  ')
    expect(empty).toContain('Instruction: (none)')
  })

  it('builds a deterministic reply for each mode', () => {
    const reply = buildDeterministicReply('rewrite', 'Polish this paragraph')

    expect(reply).toContain('[Electra · rewrite]')
    expect(reply).toContain('deterministic streamed reply')
    expect(reply).toContain('Polish this paragraph')
  })

  it('builds editor-context prompts for cursor and selection state', () => {
    const cursorPrompt = buildEditorContextSystemPrompt({
      editorContext: { kind: 'cursor', anchor: 'cursor-anchor' },
    })
    const selectionPrompt = buildEditorContextSystemPrompt({
      editorContext: { kind: 'selection', anchor: 'a', head: 'b' },
      selectedText: 'Rewrite this exact sentence.',
    })

    expect(cursorPrompt).toContain('active cursor location')
    expect(cursorPrompt).toContain('get_cursor_context')
    expect(selectionPrompt).toContain('active editor selection')
    expect(selectionPrompt).toContain('Rewrite this exact sentence.')
    expect(selectionPrompt).toContain('get_selection_snapshot')
  })

  it('builds a post-edit summary prompt from actual mutations', () => {
    const systemPrompt = buildPostEditSummarySystemPrompt()
    const userPrompt = buildPostEditSummaryPrompt({
      userRequest: 'Add a short story at the end.',
      mutations: [
        { kind: 'streaming_edit', mode: 'continue', contentFormat: 'plain_text', committedChars: 84 },
      ],
    })

    expect(systemPrompt).toContain('Do not make any more document changes')
    expect(userPrompt).toContain('User request: Add a short story at the end.')
    expect(userPrompt).toContain('completed a continue streaming edit in plain_text (84 chars)')
  })

  it('builds streaming-edit system prompts per content format', () => {
    const plain = buildStreamingEditSystemPrompt('plain_text')
    const markdown = buildStreamingEditSystemPrompt('markdown')

    expect(plain).toContain('streamed directly into a shared document')
    expect(plain).toContain('Output only the exact prose')
    expect(plain).toContain('plain prose without markdown markers')
    expect(markdown).toContain('Format the content as markdown')
    expect(markdown).toContain('Do not wrap the output in markdown code fences')
  })

  it('builds streaming-edit user prompts with instruction, context, and selection', () => {
    const continuePrompt = buildStreamingEditUserPrompt({
      mode: 'continue',
      instruction: 'Write a closing paragraph',
      documentContext: 'Existing body text.',
    })
    const rewritePrompt = buildStreamingEditUserPrompt({
      mode: 'rewrite',
      instruction: 'Make it punchier',
      documentContext: 'Existing body text.',
      selectionText: 'The old passage.',
    })
    const emptyPrompt = buildStreamingEditUserPrompt({
      mode: 'insert',
      instruction: '   ',
      documentContext: '   ',
    })

    expect(continuePrompt).toContain('Task: Continue the document from the end in the same voice.')
    expect(continuePrompt).toContain('Instruction:\nWrite a closing paragraph')
    expect(continuePrompt).toContain('Existing body text.')
    expect(continuePrompt).not.toContain('Passage to rewrite')
    expect(rewritePrompt).toContain('Passage to rewrite:\nThe old passage.')
    expect(emptyPrompt).toContain('Instruction: (none)')
    expect(emptyPrompt).toContain('Current document is empty.')
  })
})
