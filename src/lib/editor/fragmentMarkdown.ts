import * as Y from 'yjs'
// Use the EDITOR's exact Yjs binding (TipTap collaboration uses @tiptap/y-tiptap)
// so document ops and agent cursors encode/decode identically to the live editor.
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap'
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

/** ProseMirror doc + y-prosemirror mapping for the current fragment. */
export function fragmentMapping(fragment: Y.XmlFragment): {
  doc: ReturnType<typeof initProseMirrorDoc>['doc']
  mapping: unknown
} {
  const { doc, meta } = initProseMirrorDoc(fragment, gitbookSchema)
  return { doc, mapping: meta.mapping }
}

/** ProseMirror end position of a markdown prefix — used to place the agent caret. */
export function pmSizeForMarkdown(markdown: string): number {
  return gitbookSchema.nodeFromJSON(astToTiptap(parseMarkdown(markdown))).content.size
}
