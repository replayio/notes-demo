import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { GitbookEditor } from '@brett_lamy/docstream-editor'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { createRoomProvider } from '../lib/yjs/createRoomProvider'
import { avatarColor } from '../lib/ui/companies'
import type { EditorConnectionState, EditorMode } from './GitbookCollaborativeEditor'

type Props = {
  docKey: string
  localUserName: string
  localUserCompany?: string
  mode: EditorMode
  onAwarenessChange?: (awareness: Awareness | null, localClientId: number) => void
  onConnectionStateChange?: (state: EditorConnectionState) => void
  onTitleChange?: (title: string) => void
}

/** Apply a minimal prefix/suffix diff of `next` against the Y.Text contents. */
function applyMarkdownDiff(ytext: Y.Text, next: string): void {
  const prev = ytext.toString()
  if (prev === next) return
  const minLen = Math.min(prev.length, next.length)
  let prefix = 0
  while (prefix < minLen && prev[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < minLen - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const deleteCount = prev.length - prefix - suffix
  const insert = next.slice(prefix, next.length - suffix)
  ytext.doc?.transact(() => {
    if (deleteCount > 0) ytext.delete(prefix, deleteCount)
    if (insert) ytext.insert(prefix, insert)
  })
}

function firstNonEmptyLine(md: string): string {
  for (const line of md.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim()
    if (trimmed) return trimmed.slice(0, 120)
  }
  return ''
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
  const [md, setMd] = useState('')

  useEffect(() => {
    const next = createRoomProvider({
      docKey,
      localUserName,
      localUserCompany,
      localUserColor: avatarColor(localUserCompany ?? localUserName),
    })
    setRoom(next)
    setMd(next.text.toString())
    return () => {
      next.provider.destroy()
      next.awareness.destroy()
      next.ydoc.destroy()
      setRoom(null)
    }
  }, [docKey, localUserName, localUserCompany])

  useEffect(() => {
    if (!room) return
    const sync = () => setMd(room.text.toString())
    sync()
    room.text.observe(sync)
    return () => room.text.unobserve(sync)
  }, [room])

  useEffect(() => {
    if (room) onAwarenessChange?.(room.awareness, room.awareness.clientID)
    else onAwarenessChange?.(null, 0)
  }, [room, onAwarenessChange])

  const titleRef = useRef('')
  useEffect(() => {
    const title = firstNonEmptyLine(md)
    if (title !== titleRef.current) {
      titleRef.current = title
      onTitleChange?.(title)
    }
  }, [md, onTitleChange])

  useEffect(() => {
    if (!room || !onConnectionStateChange) return
    const emit = () => {
      onConnectionStateChange({
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
  }, [room, onConnectionStateChange])

  if (!room) return <p className="status-line">Connecting collaborative room…</p>

  return (
    <div className="editor-wrap">
      {mode === 'markdown' ? (
        <MarkdownMode room={room} />
      ) : (
        <GitbookEditor markdown={md} onChange={(next) => applyMarkdownDiff(room.text, next)} />
      )}
    </div>
  )
}

/** Raw GitBook markdown editing via CodeMirror bound to the same Y.Text. */
function MarkdownMode({ room }: { room: ReturnType<typeof createRoomProvider> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const undoManager = useMemo(() => new Y.UndoManager(room.text), [room])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: room.text.toString(),
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          markdown(),
          keymap.of(yUndoManagerKeymap),
          yCollab(room.text, room.awareness, { undoManager }),
        ],
      }),
    })
    view.focus()
    return () => view.destroy()
  }, [room, undoManager])

  return <div ref={hostRef} className="markdown-mode" />
}
