import { describe, it, expect } from 'vitest'
import { describeEditorStatus } from '../../src/lib/ui/editorStatus'

describe('describeEditorStatus', () => {
  it('never reports syncing while disconnected', () => {
    expect(describeEditorStatus({ status: 'disconnected', synced: false })).toBe(
      'Editor disconnected',
    )
    expect(describeEditorStatus({ status: 'disconnected', synced: true })).toBe(
      'Editor disconnected',
    )
  })

  it('reports connecting without a sync suffix', () => {
    expect(describeEditorStatus({ status: 'connecting', synced: false })).toBe(
      'Editor connecting',
    )
  })

  it('only describes the sync phase while connected', () => {
    expect(describeEditorStatus({ status: 'connected', synced: false })).toBe(
      'Editor connected · syncing',
    )
    expect(describeEditorStatus({ status: 'connected', synced: true })).toBe(
      'Editor connected · synced',
    )
  })
})

