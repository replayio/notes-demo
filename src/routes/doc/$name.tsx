import { createFileRoute, redirect } from '@tanstack/react-router'
import { slugifyWorkspace } from '../../lib/yjs/streamIds'

// Legacy single-document URLs now map onto a workspace of the same name.
export const Route = createFileRoute('/doc/$name')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$workspace',
      params: { workspace: slugifyWorkspace(params.name) },
    })
  },
})
