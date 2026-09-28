import { useEffect, useState } from 'react'
import { BookOpen, ExternalLink, HardDrive, ShieldCheck } from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import { ApiKeyCard } from '@/components/api-key-card'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, formatBytes, type Stats } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SettingsPage() {
  const { credential, setCredential, catalog } = useApp()
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined)
  }, [])

  return (
    <>
      <PageHeader title="Settings" description="Your Higgsfield connection, storage and the models this studio can use." />
      <div className="mx-auto grid max-w-3xl gap-6 px-4 py-6 sm:px-6">
        {credential && <ApiKeyCard status={credential} onChange={setCredential} />}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" /> Your data
            </CardTitle>
            <CardDescription>Everything is stored on this computer, so refreshing or restarting never loses it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {stats && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Projects', stats.projects],
                  ['Videos made', stats.by_status.completed ?? 0],
                  ['Saved files', stats.saved_files],
                  ['Disk used', formatBytes(stats.saved_bytes) || '0 B'],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border px-3 py-2">
                    <p className="text-lg font-semibold tabular-nums">{value}</p>
                    <p className="text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 text-muted-foreground">
              <p>
                <span className="text-foreground">Videos</span>: every finished video is downloaded right away into{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">data/media/…/outputs/</code>, named by its ID, with a
                small <code className="rounded bg-muted px-1 py-0.5 text-xs">.json</code> note beside it (prompt, model,
                Higgsfield request ID). Higgsfield deletes its copy after about 7 days, but yours stays.
              </p>
              <p className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                <span>
                  <span className="text-foreground">Safety net</span>: every change is also written to a plain-text
                  ledger (<code className="rounded bg-muted px-1 py-0.5 text-xs">{stats?.ledger.file ?? 'ledger.jsonl'}</code>
                  {stats ? `, ${formatBytes(stats.ledger.bytes)}` : ''}) and the database is backed up daily
                  {stats?.last_backup ? ` (latest: ${stats.last_backup})` : ''}. If the database is ever damaged, the app
                  rebuilds itself from the ledger on the next start. Running jobs resume and videos re-download for free,
                  and nothing is paid for twice.
                </span>
              </p>
              {stats && <p className="font-mono text-xs break-all">{stats.data_dir}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="size-4 text-muted-foreground" /> Available models
            </CardTitle>
            <CardDescription>Each one was checked against the Higgsfield model documentation.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {catalog?.models.map((m) => (
              <a
                key={m.id}
                href={m.docs}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Badge variant="outline" className="w-32 justify-center">
                  {catalog.modes.find((x) => x.id === m.mode)?.name}
                </Badge>
                <span className="font-medium">{m.name}</span>
                <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{m.id}</span>
                <ExternalLink className="ml-auto size-3.5 text-muted-foreground group-hover:text-foreground" />
              </a>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
