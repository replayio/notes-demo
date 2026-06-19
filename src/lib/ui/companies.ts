export type Company = {
  /** Display name used as the collaborator's identity. */
  name: string
  /** Brand-ish accent color used for the avatar. */
  color: string
}

/** Preset identities offered on the login page. */
export const COMPANIES: Company[] = [
  { name: 'Apple', color: '#1d1d1f' },
  { name: 'Google', color: '#4285f4' },
  { name: 'Microsoft', color: '#00a4ef' },
  { name: 'Amazon', color: '#ff9900' },
  { name: 'Meta', color: '#0866ff' },
  { name: 'Netflix', color: '#e50914' },
  { name: 'Tesla', color: '#cc0000' },
  { name: 'Spotify', color: '#1db954' },
  { name: 'Airbnb', color: '#ff5a5f' },
  { name: 'Uber', color: '#000000' },
]

import { slugifyWorkspace } from '../yjs/streamIds'

/** Map a workspace slug back to its company display name (workspace === company). */
export function companyFromWorkspace(workspace: string): string {
  const match = COMPANIES.find((c) => slugifyWorkspace(c.name) === workspace)
  return match ? match.name : workspace
}

const FALLBACK_COLORS = ['#2c7be5', '#e07020', '#2d9d6c', '#8a4be8', '#c94079']

/** Deterministic avatar color: brand color for known companies, hashed otherwise. */
export function avatarColor(name: string): string {
  const company = COMPANIES.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())
  if (company) return company.color
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h + name.charCodeAt(i)) % FALLBACK_COLORS.length
  }
  return FALLBACK_COLORS[h]!
}

/** Up-to-two-letter initials for an avatar from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
