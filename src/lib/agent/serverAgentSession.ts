import { YjsProvider } from '@durable-streams/y-durable-streams'
import { Doc, type Text as YText, createRelativePositionFromTypeIndex, relativePositionToJSON } from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  durableStreamsYjsBaseUrl,
  docCollaborationDocId,
  getYjsDurableStreamsHeadersServer,
  getYjsDurableStreamsOriginServer,
  getYjsDurableStreamsSecretServer,
} from '../yjs/streamIds'
import { Y_MARKDOWN_KEY } from '../yjs/createRoomProvider'
import type { AgentAwarenessStatus, AgentTransactionOrigin } from './types'

export const AGENT_DISPLAY_NAME = 'Electra'
export const AGENT_COLOR = '#7c3aed'

export function createAgentTransactionOrigin(sessionId: string): AgentTransactionOrigin {
  return { source: 'agent', sessionId }
}

function waitForProviderSync(provider: YjsProvider, timeoutMs: number): Promise<void> {
  if (provider.synced) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.off('synced', onSync)
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for provider re-sync`))
    }, timeoutMs)

    const onSync = (synced: boolean) => {
      if (!synced) return
      clearTimeout(timeout)
      provider.off('synced', onSync)
      resolve()
    }

    provider.on('synced', onSync)
  })
}

export interface ServerAgentSession {
  ydoc: Doc
  awareness: Awareness
  provider: YjsProvider
  text: YText
  sessionId: string
  setStatus: (status: AgentAwarenessStatus) => void
  /** Ephemeral composing tail (not yet committed), shown in client overlay. */
  setTail: (tail: string | null) => void
  /** Broadcast the agent cursor at a string offset in the markdown text. */
  setCursorFromIndex: (index: number) => void
  clearCursor: () => void
  destroy: () => Promise<void>
}

export function createServerAgentSession(docKey: string, sessionId: string): ServerAgentSession {
  const ydoc = new Doc()
  const awareness = new Awareness(ydoc)
  const logPrefix = `[server-agent-yjs:${docKey}:${sessionId}]`

  const setUserFields = (status: AgentAwarenessStatus) => {
    const prev = awareness.getLocalState() ?? {}
    const prevUser = (prev.user ?? {}) as Record<string, unknown>
    awareness.setLocalState({
      ...prev,
      user: {
        ...prevUser,
        name: AGENT_DISPLAY_NAME,
        color: AGENT_COLOR,
        role: 'agent',
        status,
      },
    })
  }

  setUserFields('idle')

  const baseUrl = durableStreamsYjsBaseUrl(getYjsDurableStreamsOriginServer())
  const docId = docCollaborationDocId(docKey)
  const headers = getYjsDurableStreamsHeadersServer()
  const secret = getYjsDurableStreamsSecretServer()

  const provider = new YjsProvider({
    doc: ydoc,
    baseUrl,
    docId,
    awareness,
    ...(headers ? { headers } : {}),
    connect: false,
  })
  const providerDebug = provider as any
  const directDocUrl = (() => {
    const url = new URL(`${baseUrl}/docs/${docId}`)
    if (secret) {
      url.searchParams.set('secret', secret)
    }
    return url.toString()
  })()
  if (typeof providerDebug.docUrl === 'function') {
    providerDebug.docUrl = () => directDocUrl
  }
  if (typeof providerDebug.awarenessUrl === 'function') {
    providerDebug.awarenessUrl = (name: string = 'default') => {
      const url = new URL(directDocUrl)
      url.searchParams.set('awareness', name)
      return url.toString()
    }
  }
  provider.on('status', (status) => {
    console.info(logPrefix, 'status', status)
  })
  provider.on('synced', (synced) => {
    console.info(logPrefix, 'synced', synced)
  })
  provider.on('error', (err) => {
    console.error(logPrefix, 'provider error', err)
  })
  void provider.connect()

  const text = ydoc.getText(Y_MARKDOWN_KEY)

  const setStatus = (status: AgentAwarenessStatus) => {
    setUserFields(status)
  }

  const setTail = (tail: string | null) => {
    const prev = awareness.getLocalState() ?? {}
    const prevUser = (prev.user ?? {}) as Record<string, unknown>
    const nextUser: Record<string, unknown> = {
      ...prevUser,
      name: AGENT_DISPLAY_NAME,
      color: AGENT_COLOR,
      role: 'agent',
    }
    if (tail !== null && tail.length > 0) {
      nextUser.agentTail = tail
    } else {
      delete nextUser.agentTail
    }
    awareness.setLocalState({ ...prev, user: nextUser })
  }

  const setCursorFromIndex = (index: number) => {
    const rel = createRelativePositionFromTypeIndex(text, index)
    const anchor = relativePositionToJSON(rel)
    const prev = awareness.getLocalState() ?? {}
    awareness.setLocalState({
      ...prev,
      cursor: { anchor, head: anchor },
    })
  }

  const clearCursor = () => {
    const prev = awareness.getLocalState() ?? {}
    if ('cursor' in prev) {
      const { cursor: _c, ...rest } = prev
      awareness.setLocalState(rest)
    }
  }

  const destroy = async () => {
    try {
      console.info(logPrefix, 'destroy start', {
        connected: provider.connected,
        synced: provider.synced,
      })
      try {
        awareness.setLocalState(null)
      } catch (error) {
        console.warn(logPrefix, 'failed to clear awareness state before disconnect', error)
      }
      await provider.flush().catch((error) => {
        console.warn(logPrefix, 'flush failed', error)
      })
      if (provider.connected && !provider.synced) {
        try {
          await waitForProviderSync(provider, 5_000)
        } catch (error) {
          console.warn(logPrefix, 'provider did not re-sync before disconnect', {
            error: error instanceof Error ? error.message : String(error),
            connected: provider.connected,
            synced: provider.synced,
          })
        }
      }
      await provider.disconnect().catch((error) => {
        console.warn(logPrefix, 'disconnect failed', error)
      })
    } finally {
      awareness.destroy()
      ydoc.destroy()
    }
  }

  return {
    ydoc,
    awareness,
    provider,
    text,
    sessionId,
    setStatus,
    setTail,
    setCursorFromIndex,
    clearCursor,
    destroy,
  }
}
