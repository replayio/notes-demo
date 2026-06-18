import { describe, expect, it } from 'vitest'
import { DocumentToolRuntime } from '../../src/lib/agent/documentToolRuntime'
import type {
  StreamingEditContentGenerator,
  StreamingEditGenerationContext,
} from '../../src/lib/agent/documentToolRuntime'
import { createDocumentTools } from '../../src/lib/agent/documentTools'
import { createEventCollector, createTestSession, readDocText } from './testUtils'

function createToolMap(runtime: DocumentToolRuntime) {
  return new Map(createDocumentTools(runtime).map((tool) => [tool.name, tool]))
}

function generatorFromChunks(chunks: string[]): StreamingEditContentGenerator {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

describe('server-driven streaming edit', () => {
  it('drives content into the document when a generator is bound', async () => {
    const session = createTestSession()
    const runtime = DocumentToolRuntime.createForSession({
      session,
      streamingEditGenerator: generatorFromChunks(['Hello', ' brave', ' world']),
    })
    const tools = createToolMap(runtime)
    const { context, events } = createEventCollector()

    const started = await tools.get('start_streaming_edit')!.execute?.(
      { mode: 'continue', contentFormat: 'plain_text' },
      context,
    )

    expect(started).toEqual(
      expect.objectContaining({
        ok: true,
        mode: 'continue',
        contentFormat: 'plain_text',
        editSessionId: expect.any(String),
        committedChars: 'Hello brave world'.length,
      }),
    )
    expect(readDocText(session)).toBe('Hello brave world')

    const insertStart = events.filter((event) => event.name === 'streaming-insert-start')
    const insertDeltas = events.filter((event) => event.name === 'streaming-insert-delta')
    const insertEnd = events.filter((event) => event.name === 'streaming-insert-end')
    expect(insertStart).toHaveLength(1)
    expect(insertDeltas.map((event) => event.value.delta)).toEqual(['Hello', ' brave', ' world'])
    expect(insertEnd).toHaveLength(1)
    expect(insertEnd[0]!.value).toEqual(
      expect.objectContaining({ committedChars: 'Hello brave world'.length }),
    )
    expect(events.filter((event) => event.name === 'agent-streaming-edit')).toEqual([
      {
        name: 'agent-streaming-edit',
        value: { active: true, mode: 'continue', contentFormat: 'plain_text' },
      },
      { name: 'agent-streaming-edit', value: { active: false } },
    ])

    expect(runtime.isStreamingEditActive()).toBe(false)
    runtime.destroy()
  })

  it('passes generation context including the rewrite selection text', async () => {
    const session = createTestSession()
    const observed: StreamingEditGenerationContext[] = []
    const generator: StreamingEditContentGenerator = async function* (ctx) {
      observed.push(ctx)
      yield 'fresh text'
    }
    const runtime = DocumentToolRuntime.createForSession({
      session,
      streamingEditGenerator: generator,
    })
    const tools = createToolMap(runtime)
    const { context } = createEventCollector()

    await tools.get('insert_text')!.execute?.({ text: 'old passage' }, context)
    const search = await tools.get('search_text')!.execute?.({ query: 'old passage', maxResults: 1 })
    await tools
      .get('select_text')!
      .execute?.({ matchId: (search as { matches: { matchId: string }[] }).matches[0]!.matchId }, context)
    await tools.get('start_streaming_edit')!.execute?.(
      { mode: 'rewrite', contentFormat: 'plain_text' },
      context,
    )

    expect(observed).toHaveLength(1)
    expect(observed[0]).toEqual(
      expect.objectContaining({
        mode: 'rewrite',
        contentFormat: 'plain_text',
        selectionText: 'old passage',
      }),
    )
    expect(readDocText(session)).toBe('fresh text')
    runtime.destroy()
  })

  it('commits partial content and marks the edit cancelled when generation aborts', async () => {
    const session = createTestSession()
    const generator: StreamingEditContentGenerator = async function* () {
      yield 'partial '
      throw new DOMException('Agent run aborted', 'AbortError')
    }
    const runtime = DocumentToolRuntime.createForSession({
      session,
      streamingEditGenerator: generator,
    })
    const tools = createToolMap(runtime)
    const { context, events } = createEventCollector()

    const result = await tools.get('start_streaming_edit')!.execute?.(
      { mode: 'continue', contentFormat: 'plain_text' },
      context,
    )

    expect(result).toEqual(expect.objectContaining({ ok: true, cancelled: true }))
    expect(readDocText(session)).toBe('partial ')
    const insertEnd = events.filter((event) => event.name === 'streaming-insert-end')
    expect(insertEnd).toHaveLength(1)
    expect(insertEnd[0]!.value).toEqual(expect.objectContaining({ cancelled: true }))
    expect(runtime.isStreamingEditActive()).toBe(false)
    runtime.destroy()
  })

  it('leaves manual control when no generator is bound', async () => {
    const session = createTestSession()
    const runtime = DocumentToolRuntime.createForSession({ session })
    const tools = createToolMap(runtime)
    const { context } = createEventCollector()

    expect(runtime.hasStreamingEditGenerator()).toBe(false)
    const started = await tools.get('start_streaming_edit')!.execute?.(
      { mode: 'continue', contentFormat: 'plain_text' },
      context,
    )
    expect(started).not.toHaveProperty('committedChars')
    expect(runtime.isStreamingEditActive()).toBe(true)
    runtime.destroy()
  })
})

