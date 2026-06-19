import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { useStoredDisplayName, useStoredCompany } from '../lib/ui/displayName'
import { COMPANIES, avatarColor, initials } from '../lib/ui/companies'
import { slugifyWorkspace } from '../lib/yjs/streamIds'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const navigate = Route.useNavigate()
  const { displayName, saveDisplayName } = useStoredDisplayName()
  const { company, saveCompany } = useStoredCompany()
  const [draftName, setDraftName] = useState(displayName)
  const [draftCompany, setDraftCompany] = useState(company)

  useEffect(() => {
    setDraftName(displayName)
  }, [displayName])

  useEffect(() => {
    setDraftCompany(company)
  }, [company])

  return (
    <main className="landing-page">
      <div className="landing-stack">
        <div className="landing-card">
          <p className="landing-kicker">Electra</p>
          <h1 className="page-title">Collaborative AI Editor</h1>
          <p className="page-lead">
            Pick your company workspace and start writing collaboratively
            with your teammates and an AI assistant.
          </p>
          <form
            className="landing-form"
            onSubmit={(e) => {
              e.preventDefault()
              const nextName = saveDisplayName(draftName)
              const nextCompany = saveCompany(draftCompany)
              setDraftName(nextName)
              void navigate({
                to: '/w/$workspace',
                params: { workspace: slugifyWorkspace(nextCompany) },
              })
            }}
          >
            <div className="field-stack">
              <label className="field-label" htmlFor="display-name">
                Your name
              </label>
              <div className="company-picker">
                <span
                  className="company-picker__avatar"
                  style={{ backgroundColor: avatarColor(draftCompany) }}
                  title={draftCompany}
                  aria-hidden="true"
                >
                  {initials(draftName)}
                </span>
                <Input
                  id="display-name"
                  className="doc-picker-input doc-picker-input--landing company-picker__name"
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => {
                    const next = saveDisplayName(draftName)
                    setDraftName(next)
                  }}
                  placeholder="Your name"
                  autoFocus
                />
              </div>
            </div>
            <div className="field-stack">
              <label className="field-label" htmlFor="company-select">
                Company workspace
              </label>
              <select
                id="company-select"
                className="doc-picker-input doc-picker-input--landing company-picker__select"
                value={draftCompany}
                onChange={(e) => {
                  const next = e.target.value
                  setDraftCompany(next)
                  saveCompany(next)
                }}
              >
                {COMPANIES.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" className="doc-picker-button doc-picker-button--landing">
              Open {draftCompany} workspace
            </Button>
          </form>
        </div>

        <div className="landing-overview">
          <p className="landing-overview__text">
            This app demos a collaborative AI writing workflow built on Durable Streams.
            The document is shared with Yjs over HTTP, while chat, tool calls, and model
            streams run through the Durable Session pattern for TanStack AI.
          </p>
          <p className="landing-overview__text">View the demo source on GitHub:
            {' '}
            <a
              className="landing-overview__link"
              href="https://github.com/electric-sql/collaborative-ai-editor"
              target="_blank"
              rel="noreferrer"
            >
              demo source on GitHub
            </a>
            .
          </p>
          <div className="landing-links">
            <a className="landing-link" href="https://durablestreams.com" target="_blank" rel="noreferrer">
              Durable Streams
            </a>
            <a className="landing-link" href="http://electric-sql.com/" target="_blank" rel="noreferrer">
              ElectricSQL
            </a>
            <a className="landing-link" href="http://tanstack.com/ai/" target="_blank" rel="noreferrer">
              TanStack AI
            </a>
            <a className="landing-link" href="http://yjs.dev" target="_blank" rel="noreferrer">
              Yjs
            </a>
            <a className="landing-link" href="http://prosemirror.net" target="_blank" rel="noreferrer">
              ProseMirror
            </a>
          </div>
        </div>
      </div>
    </main>
  )
}
