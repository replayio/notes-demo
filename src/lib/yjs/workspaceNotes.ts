import { useEffect, useMemo, useState } from 'react'
import { YjsProvider } from '@durable-streams/y-durable-streams'
import * as Y from 'yjs'
import { applyYjsProviderProxyCompat } from './createRoomProvider'
import { appYjsProxyBaseUrl, docCollaborationDocId, workspaceIndexDocKey } from './streamIds'

export type NoteMeta = {
  id: string
  title: string
  updatedAt: number
}

const NOTES_ARRAY_KEY = 'notes'

function createIndexProvider(docKey: string): {
  ydoc: Y.Doc
  provider: YjsProvider
  notes: Y.Array<Y.Map<unknown>>
  destroy: () => void
} {
  const ydoc = new Y.Doc()
  const baseUrl = appYjsProxyBaseUrl()
  const docId = docCollaborationDocId(docKey)
  const provider = new YjsProvider({ doc: ydoc, baseUrl, docId, connect: false })
  applyYjsProviderProxyCompat(provider, baseUrl, docId)
  provider.on('error', (err) => console.error('[workspace-index] error', err))

  let reconnecting = false
  const reconnectInterval = setInterval(() => {
    if (!provider.connected && provider.connecting && !reconnecting) {
      reconnecting = true
      provider
        .disconnect()
        .catch(() => {})
        .finally(() => provider.connect().catch(() => {}))
        .finally(() => {
          reconnecting = false
        })
    }
  }, 8000)

  void provider.connect()
  const notes = ydoc.getArray<Y.Map<unknown>>(NOTES_ARRAY_KEY)

  return {
    ydoc,
    provider,
    notes,
    destroy: () => {
      clearInterval(reconnectInterval)
      provider.destroy()
      ydoc.destroy()
    },
  }
}

function readNotes(arr: Y.Array<Y.Map<unknown>>): NoteMeta[] {
  return arr
    .toArray()
    .map((m) => ({
      id: String(m.get('id') ?? ''),
      title: String(m.get('title') ?? ''),
      updatedAt: Number(m.get('updatedAt') ?? 0),
    }))
    .filter((n) => n.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function useWorkspaceNotes(workspace: string): {
  notes: NoteMeta[]
  ready: boolean
  createNote: () => string
  renameNote: (id: string, title: string) => void
  deleteNote: (id: string) => void
} {
  const docKey = useMemo(() => workspaceIndexDocKey(workspace), [workspace])
  const [room, setRoom] = useState<ReturnType<typeof createIndexProvider> | null>(null)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const next = createIndexProvider(docKey)
    setRoom(next)
    setReady(false)

    const refresh = () => setNotes(readNotes(next.notes))
    refresh()
    next.notes.observeDeep(refresh)
    const onSynced = () => {
      refresh()
      setReady(true)
    }
    next.provider.on('synced', onSynced)

    return () => {
      next.notes.unobserveDeep(refresh)
      next.provider.off('synced', onSynced)
      next.destroy()
      setRoom(null)
    }
  }, [docKey])

  const api = useMemo(
    () => ({
      createNote: (): string => {
        const id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID().slice(0, 8)
            : Math.floor(Math.random() * 1e9).toString(36)
        if (room) {
          const map = new Y.Map<unknown>()
          map.set('id', id)
          map.set('title', '')
          map.set('updatedAt', Date.now())
          room.notes.insert(0, [map])
        }
        return id
      },
      renameNote: (id: string, title: string) => {
        if (!room) return
        const arr = room.notes.toArray()
        for (let i = 0; i < arr.length; i++) {
          if (arr[i]!.get('id') === id) {
            // Skip no-op writes — title sync fires on every edit, and rewriting
            // an unchanged title would spam the index doc.
            if (arr[i]!.get('title') === title) break
            arr[i]!.set('title', title)
            arr[i]!.set('updatedAt', Date.now())
            break
          }
        }
      },
      deleteNote: (id: string) => {
        if (!room) return
        const arr = room.notes.toArray()
        for (let i = 0; i < arr.length; i++) {
          if (arr[i]!.get('id') === id) {
            room.notes.delete(i, 1)
            break
          }
        }
      },
    }),
    [room],
  )

  return { notes, ready, ...api }
}
