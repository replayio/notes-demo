import type { EditorConnectionState } from '../../components/GitbookCollaborativeEditor'

/**
 * Map the collaborative editor connection state to a single, non-contradictory
 * status label. The previous render derived the sync suffix purely from
 * `synced`, so a disconnected room (synced === false) read as
 * "Editor disconnected · syncing" — claiming to be disconnected and syncing at
 * the same time. The sync phase is only meaningful while the provider is
 * actually connected.
 */
export function describeEditorStatus(
  state: Pick<EditorConnectionState, 'status' | 'synced'>,
): string {
  switch (state.status) {
    case 'connected':
      return state.synced ? 'Editor connected · synced' : 'Editor connected · syncing'
    case 'connecting':
      return 'Editor connecting'
    case 'disconnected':
      return 'Editor disconnected'
  }
}

