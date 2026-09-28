import { BookOpen, ExternalLink, HardDrive } from 'lucide-react'

import { PageHeader } from '@/components/app-shell'
import { ApiKeyCard } from '@/components/api-key-card'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useApp } from '@/lib/app-context'

export function SettingsPage() {
  const { credential, setCredential, catalog } = useApp()

  return (
    <>
      <PageHeader title="Settings" description="Your Higgsfield connection, storage and the models this studio can use." />
      <div className="mx-auto grid max-w-3xl gap-6 px-4 py-6 sm:px-6">
        {credential && <ApiKeyCard status={credential} onChange={setCredential} />}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" /> Storage
            </CardTitle>
            <CardDescription>Where your videos and reference files live.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm text-muted-foreground">
            <p>
              Every finished video is <span className="text-foreground">downloaded to this computer</span> (in{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">backend/data/media</code>). Higgsfield only keeps
              outputs for about 7 days, but your projects keep working after that.
            </p>
            <p>
              Reference files you upload are stored there too. They're sent to Higgsfield only when you generate with them,
              and re-sent automatically if Higgsfield's copy has expired.
            </p>
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
