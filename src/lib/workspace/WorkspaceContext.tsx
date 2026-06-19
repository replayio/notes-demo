import { createContext, useContext } from 'react'
import type { NoteMeta } from '../yjs/workspaceNotes'

export type WorkspaceContextValue = {
  workspace: string
  notes: NoteMeta[]
  ready: boolean
  createNote: () => string
  renameNote: (id: string, title: string) => void
  deleteNote: (id: string) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export const WorkspaceProvider = WorkspaceContext.Provider

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return ctx
}
