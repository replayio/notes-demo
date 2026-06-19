import { Suspense, lazy, useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'

export type EditorMode = 'rich' | 'markdown'

export type EditorConnectionState = {
  status: 'disconnected' | 'connecting' | 'connected'
  synced: boolean
  collaboratorCount: number
}

export type GitbookCollaborativeEditorProps = {
  docKey: string
  localUserName: string
  localUserCompany?: string
  mode: EditorMode
  onAwarenessChange?: (awareness: Awareness | null, localClientId: number) => void
  onConnectionStateChange?: (state: EditorConnectionState) => void
  onTitleChange?: (title: string) => void
}

// The editor pulls in TipTap, CodeMirror, and the GitBook renderer (mermaid,
// katex, …). Load it lazily so it never enters the SSR / Cloudflare worker
// bundle and only executes in the browser.
const GitbookEditorClient = lazy(() => import('./GitbookEditorClient'))

export function GitbookCollaborativeEditor(props: GitbookCollaborativeEditorProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <p className="status-line">Loading editor…</p>
  return (
    <Suspense fallback={<p className="status-line">Loading editor…</p>}>
      <GitbookEditorClient {...props} />
    </Suspense>
  )
}
