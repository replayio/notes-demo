import { streamOpenAiText } from './openaiStream'
import {
  buildStreamingEditSystemPrompt,
  buildStreamingEditUserPrompt,
} from './prompts'
import type {
  StreamingEditContentGenerator,
  StreamingEditGenerationContext,
} from './documentToolRuntime'

function resolveOpenAiApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim()
  return key && key.length > 0 ? key : null
}

function resolveOpenAiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || 'gpt-5.4'
}

/**
 * Builds the server-side streaming-edit content generator bound to the user's
 * latest instruction. It calls the OpenAI Responses API directly and yields text
 * deltas, which DocumentToolRuntime.driveStreamingEditContent commits into the
 * Yjs document. This makes content generation deterministic for an opened edit
 * session instead of depending on the model volunteering a follow-up assistant
 * text turn (bug-mqiof6o8-1og6).
 */
export function createStreamingEditContentGenerator(input: {
  instruction: string
}): StreamingEditContentGenerator {
  return async function* generate(
    ctx: StreamingEditGenerationContext,
  ): AsyncIterable<string> {
    const apiKey = resolveOpenAiApiKey()
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing on the server runtime')
    }
    const systemPrompt = buildStreamingEditSystemPrompt(ctx.contentFormat)
    const userPrompt = buildStreamingEditUserPrompt({
      mode: ctx.mode,
      instruction: input.instruction,
      documentContext: ctx.documentContext,
      ...(ctx.selectionText ? { selectionText: ctx.selectionText } : {}),
    })
    yield* streamOpenAiText({
      apiKey,
      model: resolveOpenAiModel(),
      systemPrompt,
      userPrompt,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
  }
}

