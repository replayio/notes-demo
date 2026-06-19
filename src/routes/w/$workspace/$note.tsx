import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Toolbar } from '@base-ui/react/toolbar'
import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { Separator } from '@base-ui/react/separator'
import type { Awareness } from 'y-protocols/awareness'
import { LuCode, LuFileText, LuMessageSquare, LuShare2, LuSquarePen, LuX } from 'react-icons/lu'
import { ChatSidebar, type ChatSidebarStatus } from '../../../components/ChatSidebar'
import {
  GitbookCollaborativeEditor,
  type EditorConnectionState,
  type EditorMode,
} from '../../../components/GitbookCollaborativeEditor'
import { PresenceBar } from '../../../components/PresenceBar'
import { AvatarStack } from '../../../components/AvatarStack'
import { useStoredDisplayName } from '../../../lib/ui/displayName'
import { companyFromWorkspace } from '../../../lib/ui/companies'
import { describeEditorStatus } from '../../../lib/ui/editorStatus'
import { noteDocKey } from '../../../lib/yjs/streamIds'
import { useWorkspace } from '../../../lib/workspace/WorkspaceContext'

export const Route = createFileRoute('/w/$workspace/$note')({
  component: NotePage,
})

function NotePage() {
  const { workspace, note } = Route.useParams()
  const docKey = noteDocKey(workspace, note)
  const sessionId = 'main'
  const { displayName, saveDisplayName, ready } = useStoredDisplayName()
  const company = companyFromWorkspace(workspace)
  const { notes, renameNote } = useWorkspace()
  const [draftName, setDraftName] = useState(displayName)
  const [nameModalOpen, setNameModalOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [chatOpen, setChatOpen] = useState(false)
  const [mode, setMode] = useState<EditorMode>('rich')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const shareInputRef = useRef<HTMLInputElement>(null)

  const title = useMemo(() => {
    const entry = notes.find((n) => n.id === note)
    return entry?.title?.trim() || 'New Note'
  }, [notes, note])

  const [awareness, setAwareness] = useState<Awareness | null>(null)
  const [localClientId, setLocalClientId] = useState(0)
  const [editorState, setEditorState] = useState<EditorConnectionState>({
    status: 'connecting',
    synced: false,
    collaboratorCount: 0,
  })
  const [chatState, setChatState] = useState<ChatSidebarStatus>({
    connectionStatus: 'disconnected',
    subscribed: false,
    busy: false,
  })

  useEffect(() => {
    setDraftName(displayName)
  }, [displayName])

  useEffect(() => {
    if (nameModalOpen) setTimeout(() => nameInputRef.current?.select(), 30)
  }, [nameModalOpen])

  useEffect(() => {
    if (shareModalOpen) {
      setCopyState('idle')
      setTimeout(() => shareInputRef.current?.select(), 30)
    }
  }, [shareModalOpen])

  const handleSaveName = () => {
    const next = saveDisplayName(draftName)
    setDraftName(next)
    setNameModalOpen(false)
  }

  const shareUrl =
    typeof window !== 'undefined' ? window.location.href : `http://localhost:3000/w/${workspace}/${note}`

  const handleCopyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  const handleNativeShare = async () => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return
    try {
      await navigator.share({ title, text: `Join me in ${title}`, url: shareUrl })
    } catch {
      // user cancelled or share failed; keep modal open
    }
  }

  return (
    <div className="doc-shell">
      <Toolbar.Root className="doc-toolbar" aria-label="Document toolbar">
        <div className="doc-toolbar__crumbs">
          <span className="crumb-current">
            <LuFileText aria-hidden="true" />
            <span>{title}</span>
          </span>
        </div>

        <div className="mode-toggle" role="tablist" aria-label="Editor mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rich'}
            className={`mode-toggle__btn${mode === 'rich' ? ' mode-toggle__btn--active' : ''}`}
            onClick={() => setMode('rich')}
          >
            <LuSquarePen aria-hidden="true" /> Rich
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'markdown'}
            className={`mode-toggle__btn${mode === 'markdown' ? ' mode-toggle__btn--active' : ''}`}
            onClick={() => setMode('markdown')}
          >
            <LuCode aria-hidden="true" /> Markdown
          </button>
        </div>

        {awareness && (
          <div className="doc-toolbar__presence">
            <PresenceBar
              awareness={awareness}
              localClientId={localClientId}
              onClickLocal={() => setNameModalOpen(true)}
            />
          </div>
        )}

        <Button
          className="share-toggle-btn"
          aria-label="Share note"
          onClick={() => setShareModalOpen(true)}
        >
          <LuShare2 aria-hidden="true" />
        </Button>

        <Button
          className="chat-toggle-btn"
          aria-label={chatOpen ? 'Close chat' : 'Open chat'}
          onClick={() => setChatOpen((v) => !v)}
        >
          {chatOpen ? <LuX aria-hidden="true" /> : <LuMessageSquare aria-hidden="true" />}
        </Button>
      </Toolbar.Root>

      <div className="doc-shell__body">
        <div className="doc-pane doc-pane--editor">
          {awareness && <AvatarStack awareness={awareness} localClientId={localClientId} />}
          <div className="editor-scroll">
            <div className="doc-pane__content">
              <GitbookCollaborativeEditor
                key={docKey}
                docKey={docKey}
                localUserName={ready ? displayName : 'Guest'}
                localUserCompany={company}
                mode={mode}
                onConnectionStateChange={setEditorState}
                onTitleChange={(t) => renameNote(note, t)}
                onAwarenessChange={(aw, id) => {
                  setAwareness(aw)
                  setLocalClientId(id)
                }}
              />
            </div>
          </div>
        </div>

        <Separator className="pane-separator" orientation="vertical" />

        <div className={`doc-pane doc-pane--chat${chatOpen ? ' doc-pane--chat-open' : ''}`}>
          <ChatSidebar
            docKey={docKey}
            sessionId={sessionId}
            displayName={ready ? displayName : 'Guest'}
            editorContext={null}
            onStatusChange={setChatState}
          />
        </div>

        {chatOpen && <div className="chat-overlay-backdrop" onClick={() => setChatOpen(false)} />}
      </div>

      {nameModalOpen && (
        <div
          className="name-modal-overlay"
          onClick={() => setNameModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Edit your display name"
        >
          <div className="name-modal" onClick={(e) => e.stopPropagation()}>
            <p className="name-modal__label">Your display name</p>
            <Input
              ref={nameInputRef}
              className="name-modal__input"
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveName()
                if (e.key === 'Escape') setNameModalOpen(false)
              }}
              placeholder="Display name"
            />
            <div className="name-modal__actions">
              <Button
                className="name-modal__btn name-modal__btn--cancel"
                onClick={() => setNameModalOpen(false)}
              >
                Cancel
              </Button>
              <Button className="name-modal__btn name-modal__btn--save" onClick={handleSaveName}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {shareModalOpen && (
        <div
          className="name-modal-overlay"
          onClick={() => setShareModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Share document"
        >
          <div className="name-modal share-modal" onClick={(e) => e.stopPropagation()}>
            <p className="name-modal__label">Share this note</p>
            <Input
              ref={shareInputRef}
              className="name-modal__input"
              type="text"
              value={shareUrl}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Share URL"
            />
            <div className="share-modal__hint">
              {copyState === 'copied'
                ? 'URL copied.'
                : copyState === 'error'
                  ? 'Could not copy URL.'
                  : 'Anyone with the link can open this note.'}
            </div>
            <div className="name-modal__actions">
              <Button
                className="name-modal__btn name-modal__btn--cancel"
                onClick={() => setShareModalOpen(false)}
              >
                Close
              </Button>
              <Button
                className="name-modal__btn share-modal__btn"
                onClick={() => {
                  void handleCopyShareUrl()
                }}
              >
                Copy URL
              </Button>
              <Button
                className="name-modal__btn name-modal__btn--save"
                onClick={() => {
                  void handleNativeShare()
                }}
                disabled={typeof navigator === 'undefined' || typeof navigator.share !== 'function'}
              >
                Share
              </Button>
            </div>
          </div>
        </div>
      )}

      <footer className="status-bar">
        <div className="status-bar__item">{describeEditorStatus(editorState)}</div>
        <div className="status-bar__item">
          Chat {chatState.connectionStatus}
          {chatState.subscribed ? ' · subscribed' : ''}
        </div>
        <div className="status-bar__item">Participants {editorState.collaboratorCount}</div>
        <div className="status-bar__item">Session {chatState.busy ? 'running' : 'idle'}</div>
      </footer>
    </div>
  )
}
