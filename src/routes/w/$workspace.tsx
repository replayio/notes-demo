import { createFileRoute, Outlet, useParams } from '@tanstack/react-router'
import { NotesSidebar } from '../../components/NotesSidebar'
import { WorkspaceProvider } from '../../lib/workspace/WorkspaceContext'
import { useWorkspaceNotes } from '../../lib/yjs/workspaceNotes'

export const Route = createFileRoute('/w/$workspace')({
  component: WorkspaceLayout,
})

function WorkspaceLayout() {
  const { workspace } = Route.useParams()
  const notesApi = useWorkspaceNotes(workspace)
  const childParams = useParams({ strict: false }) as { note?: string }

  return (
    <WorkspaceProvider value={{ workspace, ...notesApi }}>
      <main className="workspace-shell">
        <NotesSidebar selectedNoteId={childParams.note} />
        <div className="workspace-main">
          <Outlet />
        </div>
      </main>
    </WorkspaceProvider>
  )
}
