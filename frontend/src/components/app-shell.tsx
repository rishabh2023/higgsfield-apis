import { useEffect, useState } from 'react'
import { AlertTriangle, Film, FolderOpen, KeyRound, Settings } from 'lucide-react'
import { Link, NavLink, Outlet } from 'react-router'

import { Tip } from '@/components/hint'
import { ApiError, api, EXPECTED_API_VERSION } from '@/lib/api'
import { canGenerate, useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/projects', label: 'Projects', icon: FolderOpen },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function AppShell() {
  const { credential } = useApp()
  const ready = canGenerate(credential)
  // The page updates itself instantly, but an old server process keeps old code until restarted.
  const [stale, setStale] = useState(false)
  useEffect(() => {
    // Servers older than this endpoint answer 404, which also means "restart needed".
    const check = () => api.version()
      .then((v) => setStale(v.api_version < EXPECTED_API_VERSION))
      .catch((e) => { if (e instanceof ApiError && e.status === 404) setStale(true) })
    check()
    const t = setInterval(check, 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex min-h-svh flex-col bg-background md:flex-row">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:flex md:h-svh md:w-60 md:shrink-0 md:flex-col md:border-r md:border-b-0">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <Link to="/projects" className="flex items-center gap-2.5">
            <div className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-sky-500">
              <Film className="size-4 text-white" />
            </div>
            <span className="font-semibold tracking-tight">Video Studio</span>
          </Link>
        </div>
        <nav className="flex gap-1 px-3 pb-3 md:flex-col md:pb-0">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  isActive && 'bg-accent font-medium text-foreground',
                )
              }
            >
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden p-3 md:block">
          {credential && (
            <Tip side="right" label={ready ? 'Your Higgsfield key is saved and working. Click to manage it.' : 'Generating needs your Higgsfield API key. Click to add it.'}>
            <Link
              to="/settings"
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors hover:bg-accent',
                ready ? 'text-muted-foreground' : 'border-amber-500/40 text-amber-300',
              )}
            >
              <KeyRound className="size-3.5" />
              {ready ? (
                <span>
                  API key <span className="font-mono">{credential.key_hint}</span>
                </span>
              ) : (
                <span>Add your Higgsfield API key</span>
              )}
              <span className={cn('ml-auto size-2 rounded-full', ready ? 'bg-emerald-400' : 'bg-amber-400')} />
            </Link>
            </Tip>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {stale && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              The app’s server is running an older version, so some buttons won’t work. In the terminal, press{' '}
              <kbd className="rounded border border-amber-300/40 px-1 text-xs">Ctrl</kbd>+<kbd className="rounded border border-amber-300/40 px-1 text-xs">C</kbd>{' '}
              and run <code className="rounded bg-black/30 px-1 text-xs">./start.sh</code> again. Nothing is lost.
            </span>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}

export function PageHeader({ title, description, actions, back }: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  back?: React.ReactNode
}) {
  return (
    <div className="border-b">
      <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4 px-4 py-5 sm:px-6">
        <div className="min-w-0">
          {back}
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
