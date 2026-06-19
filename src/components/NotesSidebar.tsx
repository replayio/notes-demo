import { useNavigate } from '@tanstack/react-router'
import { Button, GridList, GridListItem } from 'react-aria-components'
import { LuFileText, LuPlus, LuTrash2 } from 'react-icons/lu'
import { useWorkspace } from '../lib/workspace/WorkspaceContext'
import { avatarColor, companyFromWorkspace, initials } from '../lib/ui/companies'

function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function previewTitle(title: string): string {
  return title.trim() || 'New Note'
}

export function NotesSidebar({ selectedNoteId }: { selectedNoteId?: string }) {
  const { workspace, notes, createNote, deleteNote } = useWorkspace()
  const companyName = companyFromWorkspace(workspace)
  const navigate = useNavigate()

  const goToNote = (id: string) => {
    void navigate({ to: '/w/$workspace/$note', params: { workspace, note: id } })
  }

  const handleCreate = () => {
    const id = createNote()
    goToNote(id)
  }

  const handleDelete = (id: string) => {
    deleteNote(id)
    if (id === selectedNoteId) {
      void navigate({ to: '/w/$workspace', params: { workspace } })
    }
  }

  return (
    <aside className="notes-sidebar">
      <div className="notes-sidebar__header">
        <span className="notes-sidebar__company">
          <span
            className="notes-sidebar__company-avatar"
            style={{ backgroundColor: avatarColor(companyName) }}
            aria-hidden="true"
          >
            {initials(companyName)}
          </span>
          <span className="notes-sidebar__title">{companyName}</span>
        </span>
        <Button className="notes-sidebar__new" onPress={handleCreate} aria-label="New note">
          <LuPlus aria-hidden="true" />
        </Button>
      </div>

      <GridList
        className="notes-list"
        aria-label={`Notes in ${workspace}`}
        selectionMode="single"
        selectedKeys={selectedNoteId ? [selectedNoteId] : []}
        onSelectionChange={(keys) => {
          if (keys === 'all') return
          const first = [...keys][0]
          if (typeof first === 'string') goToNote(first)
        }}
        renderEmptyState={() => (
          <div className="notes-list__empty">
            No notes yet. Create your first note.
          </div>
        )}
      >
        {notes.map((note) => (
          <GridListItem
            key={note.id}
            id={note.id}
            textValue={previewTitle(note.title)}
            className="note-item"
          >
            <span className="note-item__icon" aria-hidden="true">
              <LuFileText />
            </span>
            <span className="note-item__body">
              <span className="note-item__title">{previewTitle(note.title)}</span>
              <span className="note-item__meta">{relativeTime(note.updatedAt)}</span>
            </span>
            <Button
              className="note-item__delete"
              aria-label={`Delete ${previewTitle(note.title)}`}
              onPress={() => handleDelete(note.id)}
              slot={null}
            >
              <LuTrash2 aria-hidden="true" />
            </Button>
          </GridListItem>
        ))}
      </GridList>
    </aside>
  )
}
