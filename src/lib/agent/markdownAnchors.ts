import * as Y from 'yjs'

/**
 * Stable anchors for the markdown document. The document is a single `Y.Text`,
 * so an anchor is a Yjs relative position into that text — robust to concurrent
 * insertions/deletions, unlike a raw integer offset.
 */

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode a string offset into `text` as portable relative-position bytes. */
export function encodeAnchor(text: Y.Text, index: number): Uint8Array {
  const rel = Y.createRelativePositionFromTypeIndex(text, index)
  return Y.encodeRelativePosition(rel)
}

/** Resolve relative-position bytes back to a string offset, or null if invalid. */
export function decodeAnchor(ydoc: Y.Doc, bytes: Uint8Array): number | null {
  const rel = Y.decodeRelativePosition(bytes)
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc)
  return abs ? abs.index : null
}

export function encodeAnchorBase64(text: Y.Text, index: number): string {
  return bytesToBase64(encodeAnchor(text, index))
}

export function decodeAnchorBase64(b64: string): Uint8Array {
  return base64ToBytes(b64)
}

export function bytesToBase64Str(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
}
