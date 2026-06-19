import * as Y from 'yjs'
import { initProseMirrorDoc, updateYFragment } from 'y-prosemirror'
import {
  astToTiptap,
  getGitbookSchema,
  tiptapToAst,
  type PMNode,
} from '@brett_lamy/docstream-editor'
import { parseMarkdown, serializeMarkdown } from '@brett_lamy/docstream/gitbook'

/**
 * Bridge between the collaborative `Y.XmlFragment` (the document's source of
 * truth, edited natively by TipTap) and GitBook markdown — used by the raw
 * markdown mode and the server-side AI, which both think in markdown.
 *
 * Uses the editor's exact schema so y-prosemirror sync stays consistent with the
 * live editor.
 */
export const gitbookSchema = getGitbookSchema()

/** Serialize the current fragment to GitBook markdown. */
export function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  const { doc } = initProseMirrorDoc(fragment, gitbookSchema)
  return serializeMarkdown(tiptapToAst(doc.toJSON() as PMNode))
}

/** Replace the fragment's content with the parsed markdown (minimal diff). */
export function writeMarkdownToFragment(
  ydoc: Y.Doc,
  fragment: Y.XmlFragment,
  markdown: string,
  origin?: unknown,
): void {
  // `meta` (not `meta.mapping`) is the 4th arg — updateYFragment does meta.mapping.set(...).
  const { meta } = initProseMirrorDoc(fragment, gitbookSchema)
  const newDoc = gitbookSchema.nodeFromJSON(astToTiptap(parseMarkdown(markdown)))
  ydoc.transact(() => {
    updateYFragment(ydoc, fragment, newDoc, meta as never)
  }, origin)
}
