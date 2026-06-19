import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { GitbookEditor } from '@brett_lamy/docstream-editor'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { createRoomProvider } from '../lib/yjs/createRoomProvider'
import { fragmentToMarkdown, writeMarkdownToFragment } from '../lib/editor/fragmentMarkdown'
import { avatarColor } from '../lib/ui/companies'
import type { EditorConnectionState, EditorMode } from './GitbookCollaborativeEditor'

type Awareness = ReturnType<typeof createRoomProvider>['awareness']

type Props = {
  docKey: string
  localUserName: string
  localUserCompany?: string
  mode: EditorMode
  onAwarenessChange?: (awareness: Awareness | null, localClientId: number) => void
  onConnectionStateChange?: (state: EditorConnectionState) => void
  onTitleChange?: (title: string) => void
}

const MARKDOWN_ORIGIN = Symbol('markdown-mode')

function firstTextblockTitle(editor: TiptapEditor): string {
  let title = ''
  editor.state.doc.descendants((node: import('@tiptap/pm/model').Node) => {
    if (title) return false
    if (node.isTextblock) {
      title = node.textContent.trim()
      return false
    }
    return true
  })
  return title.slice(0, 120)
}

export default function GitbookEditorClient({
  docKey,
  localUserName,
  localUserCompany,
  mode,
  onAwarenessChange,
  onConnectionStateChange,
  onTitleChange,
}: Props) {
  const [room, setRoom] = useState<ReturnType<typeof createRoomProvider> | null>(null)

  // Keep callbacks in refs so stable effect/handler identities don't re-fire
  // (a changing onEditorReady would otherwise stack editor 'update' listeners).
  const onAwarenessRef = useRef(onAwarenessChange)
  const onConnRef = useRef(onConnectionStateChange)
  const onTitleRef = useRef(onTitleChange)
  onAwarenessRef.current = onAwarenessChange
  onConnRef.current = onConnectionStateChange
  onTitleRef.current = onTitleChange

  useEffect(() => {
    const next = createRoomProvider({
      docKey,
      localUserName,
      localUserCompany,
      localUserColor: avatarColor(localUserCompany ?? localUserName),
    })
    setRoom(next)
    return () => {
      next.provider.destroy()
      next.awareness.destroy()
      next.ydoc.destroy()
      setRoom(null)
    }
  }, [docKey, localUserName, localUserCompany])

  useEffect(() => {
    if (room) onAwarenessRef.current?.(room.awareness, room.awareness.clientID)
    else onAwarenessRef.current?.(null, 0)
  }, [room])

  useEffect(() => {
    if (!room) return
    const emit = () => {
      onConnRef.current?.({
        status: room.provider.connected
          ? 'connected'
          : room.provider.connecting
            ? 'connecting'
            : 'disconnected',
        synced: room.provider.synced,
        collaboratorCount: room.awareness.getStates().size,
      })
    }
    room.provider.on('status', emit)
    room.provider.on('synced', emit)
    room.awareness.on('change', emit)
    emit()
    return () => {
      room.provider.off('status', emit)
      room.provider.off('synced', emit)
      room.awareness.off('change', emit)
    }
  }, [room])

  const extensions = useMemo(() => {
    if (!room) return null
    return [
      Collaboration.configure({ fragment: room.fragment }),
      CollaborationCaret.configure({
        provider: { awareness: room.awareness },
        user: {
          name: localUserName,
          color: avatarColor(localUserCompany ?? localUserName),
          company: localUserCompany,
        },
      }),
    ]
  }, [room, localUserName, localUserCompany])

  // Stable: attaches a single 'update' listener that syncs the title (deduped).
  const lastTitleRef = useRef<string | null>(null)
  const handleEditorReady = useCallback((editor: TiptapEditor | null) => {
    if (!editor) return
    const sync = () => {
      const title = firstTextblockTitle(editor)
      if (title === lastTitleRef.current) return
      lastTitleRef.current = title
      onTitleRef.current?.(title)
    }
    queueMicrotask(sync)
    editor.on('update', sync)
  }, [])

  if (!room || !extensions) return <p className="status-line">Connecting collaborative room…</p>

  return (
    <div className="editor-wrap">
      {mode === 'markdown' ? (
        <MarkdownMode room={room} />
      ) : (
        <GitbookEditor extensions={extensions} disableHistory onEditorReady={handleEditorReady} />
      )}
    </div>
  )
}

/**
 * Raw GitBook markdown editing. Loads the current fragment as markdown and writes
 * edits back into the shared fragment. A focused source-editing surface (not a
 * live char-CRDT like the rich view).
 */
function MarkdownMode({ room }: { room: ReturnType<typeof createRoomProvider> }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: string | null = null

    const flush = () => {
      if (pending === null) return
      const md = pending
      pending = null
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      writeMarkdownToFragment(room.ydoc, room.fragment, md, MARKDOWN_ORIGIN)
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: fragmentToMarkdown(room.fragment),
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          markdown(),
          keymap.of(defaultKeymap),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            pending = u.state.doc.toString()
            if (timer) clearTimeout(timer)
            timer = setTimeout(flush, 300)
          }),
        ],
      }),
    })
    view.focus()
    return () => {
      flush()
      view.destroy()
    }
  }, [room])

  return <div ref={hostRef} className="markdown-mode" />
}
