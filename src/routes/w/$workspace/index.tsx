import { createFileRoute } from '@tanstack/react-router'
import { Button } from 'react-aria-components'
import { LuNotebookPen } from 'react-icons/lu'
import { useWorkspace } from '../../../lib/workspace/WorkspaceContext'

export const Route = createFileRoute('/w/$workspace/')({
  component: WorkspaceEmpty,
})

function WorkspaceEmpty() {
  const { workspace } = Route.useParams()
  const navigate = Route.useNavigate()
  const { createNote } = useWorkspace()

  return (
    <div className="note-empty">
      <LuNotebookPen className="note-empty__icon" aria-hidden="true" />
      <p className="note-empty__title">No note selected</p>
      <p className="note-empty__lead">Choose a note from the sidebar, or create a new one.</p>
      <Button
        className="note-empty__btn"
        onPress={() => {
          const id = createNote()
          void navigate({ to: '/w/$workspace/$note', params: { workspace, note: id } })
        }}
      >
        Create note
      </Button>
    </div>
  )
}
