import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { avatarColor, initials } from '../lib/ui/companies'

type Editor = {
  clientId: number
  name: string
  color: string
  company?: string
  role?: string
}

type CompanyGroup = {
  company: string
  color: string
  members: Editor[]
}

const NO_COMPANY = 'Guests'

/**
 * Apple Notes–style collaborator presence, grouped by company. Each company
 * shows a cluster of its members' avatars so you can see who from your
 * company is in the note alongside everyone else.
 */
export function AvatarStack({
  awareness,
  localClientId,
}: {
  awareness: Awareness
  localClientId?: number
}) {
  const [editors, setEditors] = useState<Editor[]>([])

  useEffect(() => {
    const refresh = () => {
      const raw: Editor[] = []
      awareness.getStates().forEach((state, clientId) => {
        const user = state?.user as
          | { name?: string; color?: string; company?: string; role?: string }
          | undefined
        if (user?.name) {
          raw.push({
            clientId,
            name: user.name,
            color: user.color ?? '#666',
            company: user.company,
            role: user.role,
          })
        }
      })
      // Deduplicate by company+name+role; prefer the local client's entry.
      const seen = new Map<string, Editor>()
      for (const e of raw) {
        const key = `${e.company ?? ''}:${e.name}:${e.role ?? ''}`
        const existing = seen.get(key)
        if (!existing || e.clientId === localClientId) seen.set(key, e)
      }
      setEditors(Array.from(seen.values()))
    }
    refresh()
    awareness.on('update', refresh)
    return () => awareness.off('update', refresh)
  }, [awareness, localClientId])

  if (editors.length === 0) return null

  // Group editors by company, preserving first-seen order.
  const groupMap = new Map<string, CompanyGroup>()
  for (const e of editors) {
    const company = e.role === 'agent' ? 'AI' : e.company ?? NO_COMPANY
    let group = groupMap.get(company)
    if (!group) {
      group = { company, color: avatarColor(company), members: [] }
      groupMap.set(company, group)
    }
    group.members.push(e)
  }
  const groups = Array.from(groupMap.values())

  return (
    <div className="avatar-stack" aria-label="People editing this note">
      {groups.map((group) => (
        <div className="company-group" key={group.company} title={group.company}>
          <span className="company-group__label">{group.company}</span>
          <div className="company-group__avatars">
            {group.members.map((e) => {
              const isLocal = e.clientId === localClientId
              const isAgent = e.role === 'agent'
              const label = `${e.name} · ${group.company}${isLocal ? ' (you)' : ''}`
              return (
                <span
                  key={e.clientId}
                  className={`avatar${isLocal ? ' avatar--local' : ''}`}
                  style={{ backgroundColor: group.color }}
                  title={label}
                  aria-label={label}
                >
                  {isAgent ? 'AI' : initials(e.name)}
                </span>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
