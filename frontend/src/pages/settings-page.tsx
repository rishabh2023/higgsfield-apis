import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, BookOpen, Download, ExternalLink, Eraser, FileJson, HardDrive, Loader2, RefreshCw, ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'

import { ApiKeyCard } from '@/components/api-key-card'
import { PageHeader } from '@/components/app-shell'
import { Hint, Tip } from '@/components/hint'
import { MediaThumb } from '@/components/media'
import { JsonBlock } from '@/components/raw-dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  api, formatBytes, timeAgo, type LedgerEntry, type Stats, type StorageList, type StoredFile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function SettingsPage() {
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') || 'general'
  return (
    <>
      <PageHeader title="Settings" description="Your Higgsfield connection, the files stored on this computer, and the raw records behind them." />
      <Tabs value={tab} onValueChange={(t) => setSearch({ tab: t }, { replace: true })} className="mx-auto max-w-5xl gap-6 px-4 py-6 sm:px-6">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="storage"><HardDrive /> Storage</TabsTrigger>
          <TabsTrigger value="raw"><FileJson /> Raw data</TabsTrigger>
        </TabsList>
        <TabsContent value="general"><GeneralTab /></TabsContent>
        <TabsContent value="storage"><StorageTab /></TabsContent>
        <TabsContent value="raw"><RawTab /></TabsContent>
      </Tabs>
    </>
  )
}

// ------------------------------------------------------------------ General

function GeneralTab() {
  const { credential, setCredential, catalog } = useApp()
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined)
  }, [])

  return (
    <div className="grid gap-6">
      {credential && <ApiKeyCard status={credential} onChange={setCredential} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-400" /> Your data is safe</CardTitle>
          <CardDescription>Everything is stored on this computer, so refreshing or restarting never loses it.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Projects', stats?.projects, 'Folders that group your videos and reference files.'],
              ['Videos made', stats?.by_status.completed ?? (stats ? 0 : undefined), 'Finished videos, each saved as an MP4 on this computer.'],
              ['Saved files', stats?.saved_files, 'Generated videos plus the reference files you uploaded.'],
              ['Disk used', stats ? formatBytes(stats.saved_bytes) || '0 B' : undefined, 'Space these files take on this computer.'],
            ].map(([label, value, tip]) => (
              <Tip key={label as string} label={tip}>
                <div className="cursor-help rounded-lg border px-3 py-2">
                  <p className="text-lg font-semibold tabular-nums">{value ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </Tip>
            ))}
          </div>
          <ul className="grid gap-2 text-muted-foreground">
            <li><span className="text-foreground">Saved right away:</span> every finished video is downloaded into{' '}
              <code className="rounded bg-muted px-1 text-xs">data/media/…/outputs/</code>, named by its ID, with a{' '}
              <code className="rounded bg-muted px-1 text-xs">.json</code> note (prompt, model, request ID). Higgsfield deletes its copy after about 7 days, but yours stays.</li>
            <li><span className="text-foreground">Safety net:</span> every change is also written to a plain-text ledger
              {stats ? ` (${formatBytes(stats.ledger.bytes)})` : ''} and the database is backed up daily
              {stats?.last_backup ? ` (latest: ${stats.last_backup})` : ''}. If the database is ever damaged, the app rebuilds itself. Unfinished videos continue and missing files re-download for free.</li>
            <li><span className="text-foreground">No double charges:</span> repeated clicks, refreshes and dropped connections never pay twice, and the app asks before re-making an identical video.</li>
          </ul>
          {stats && <p className="font-mono text-xs break-all text-muted-foreground/80">{stats.data_dir}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="size-4 text-muted-foreground" /> Available models</CardTitle>
          <CardDescription>Each one was checked against the Higgsfield model documentation. Click one to open its docs.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {catalog?.models.map((m) => (
            <a key={m.id} href={m.docs} target="_blank" rel="noreferrer"
              className="group flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent">
              <Badge variant="outline" className="w-36 justify-center">{catalog.modes.find((x) => x.id === m.mode)?.name}</Badge>
              <span className="font-medium">{m.name}</span>
              <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{m.id}</span>
              <ExternalLink className="ml-auto size-3.5 text-muted-foreground group-hover:text-foreground" />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Storage

function StorageTab() {
  const [data, setData] = useState<StorageList | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [kind, setKind] = useState('all')
  const [source, setSource] = useState('all')
  const [preview, setPreview] = useState<StoredFile | null>(null)
  const [confirm, setConfirm] = useState<null | { title: string; body: string; run: () => Promise<unknown>; danger?: boolean }>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.storage().then((d) => {
      setData(d)
      setSelected((s) => s.filter((id) => d.files.some((f) => f.id === id)))
    }).catch((e) => toast.error(e.message))
  }, [])
  useEffect(load, [load])

  const files = useMemo(() => (data?.files ?? []).filter((f) =>
    (kind === 'all' || f.kind === kind) && (source === 'all' || f.source === source)), [data, kind, source])
  const selectedBytes = (data?.files ?? []).filter((f) => selected.includes(f.id)).reduce((n, f) => n + (f.size_bytes ?? 0), 0)
  const allShownSelected = files.length > 0 && files.every((f) => selected.includes(f.id))

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
      setConfirm(null)
      setTyped('')
    }
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Stored clips <Hint>Every video you generated and every file you uploaded, as saved on this computer.</Hint>
          </CardTitle>
          <CardDescription>
            {data ? <>{data.files.length} files · {formatBytes(data.total_bytes) || '0 B'} · {data.counts.outputs} generated, {data.counts.uploads} uploaded</> : 'Loading…'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="generation">Generated videos</SelectItem>
                <SelectItem value="upload">My uploads</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="image">Image</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
              </SelectContent>
            </Select>
            <Tip label="Reload the list">
              <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh"><RefreshCw /></Button>
            </Tip>
            <div className="ml-auto flex items-center gap-2">
              {selected.length > 0 && <span className="text-xs text-muted-foreground">{selected.length} selected · {formatBytes(selectedBytes)}</span>}
              <Tip label="Permanently delete the selected files. Generated videos disappear from their project too.">
                <span>
                  <Button variant="destructive" size="sm" disabled={!selected.length || busy} onClick={() => setConfirm({
                    title: `Delete ${selected.length} file${selected.length > 1 ? 's' : ''}?`,
                    body: 'They will be removed from this computer and from their projects. Download anything you want to keep first. Nothing is deleted on Higgsfield.',
                    run: () => api.deleteFiles(selected),
                  })}>
                    <Trash2 /> Delete selected
                  </Button>
                </span>
              </Tip>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[28px_64px_1fr_auto] items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-[28px_64px_1fr_130px_90px_80px]">
              <input type="checkbox" aria-label="Select all shown" checked={allShownSelected}
                onChange={() => setSelected(allShownSelected ? selected.filter((id) => !files.some((f) => f.id === id)) : [...new Set([...selected, ...files.map((f) => f.id)])])} />
              <span />
              <span>File</span>
              <span className="hidden sm:block">Project</span>
              <span className="hidden sm:block">Size</span>
              <span className="text-right">Added</span>
            </div>
            {data === null ? (
              <div className="grid place-items-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : files.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No files here.</p>
            ) : (
              <ul className="max-h-[520px] divide-y overflow-y-auto">
                {files.map((f) => (
                  <li key={f.id} className={cn('grid grid-cols-[28px_64px_1fr_auto] items-center gap-3 px-3 py-2 text-sm sm:grid-cols-[28px_64px_1fr_130px_90px_80px]', selected.includes(f.id) && 'bg-violet-500/5')}>
                    <input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.includes(f.id)}
                      onChange={() => setSelected((s) => (s.includes(f.id) ? s.filter((x) => x !== f.id) : [...s, f.id]))} />
                    <button type="button" onClick={() => setPreview(f)} className="overflow-hidden rounded border" aria-label={`Preview ${f.name}`}>
                      <MediaThumb kind={f.kind} url={f.url} className="aspect-video w-16" />
                    </button>
                    <div className="min-w-0">
                      <button type="button" onClick={() => setPreview(f)} className="block max-w-full truncate text-left hover:underline" title={f.name}>{f.name}</button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{f.source === 'generation' ? 'generated' : 'uploaded'}</Badge>
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{f.kind}</Badge>
                        {f.used_as_input && <Tip label="Used as an input by at least one generation"><Badge variant="secondary" className="h-4 cursor-help px-1.5 text-[10px]">in use</Badge></Tip>}
                        {!f.on_disk && <Tip label={f.status === 'downloading' ? 'Still being saved from Higgsfield' : 'No local copy. It plays from Higgsfield while that copy lasts.'}><Badge variant="destructive" className="h-4 cursor-help px-1.5 text-[10px]">{f.status === 'downloading' ? 'saving…' : 'not on disk'}</Badge></Tip>}
                      </div>
                    </div>
                    <span className="hidden truncate text-xs text-muted-foreground sm:block">{f.project_name}</span>
                    <span className="hidden text-xs text-muted-foreground tabular-nums sm:block">{formatBytes(f.size_bytes) || '—'}</span>
                    <span className="text-right text-xs text-muted-foreground">{timeAgo(f.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Eraser className="size-4 text-muted-foreground" /> Quick clean-up</CardTitle>
          <CardDescription>Free up space without touching your good videos.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          <CleanAction title="Clear failed attempts" body="Removes cards for videos that failed, were blocked, rejected or canceled. You weren't charged for these." disabled={busy}
            onClick={() => setConfirm({ title: 'Clear failed attempts?', body: 'Failed, blocked, rejected and canceled videos will be removed from your projects.', run: () => api.clearStorage('failed') })} />
          <CleanAction title="Clear unused uploads" body="Deletes uploaded reference files that no generation has used." disabled={busy}
            onClick={() => setConfirm({ title: 'Clear unused uploads?', body: 'Uploaded files that were never used in a generation will be deleted from this computer.', run: () => api.clearStorage('unused_uploads') })} />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-300"><AlertTriangle className="size-4" /> Danger zone</CardTitle>
          <CardDescription>Deletes all projects, videos and files in this browser from this computer. Your API key is kept. This cannot be undone.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" disabled={busy} onClick={() => setConfirm({
            title: 'Delete everything?', danger: true,
            body: 'All projects, generated videos and uploaded files will be permanently deleted from this computer. Download anything you want to keep first.',
            run: () => api.clearStorage('everything'),
          })}>
            <Trash2 /> Clear all data
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={!!confirm} onOpenChange={(v) => { if (!v) { setConfirm(null); setTyped('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.danger && (
            <div className="grid gap-2">
              <p className="text-sm">Type <b>DELETE</b> to confirm.</p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy || (!!confirm?.danger && typed !== 'DELETE')}
              onClick={(e) => {
                e.preventDefault()
                if (confirm) run(confirm.run, 'Done')
              }}>
              {busy && <Loader2 className="animate-spin" />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="sm:max-w-3xl">
          {preview && (
            <>
              <DialogHeader><DialogTitle className="truncate pr-6">{preview.name}</DialogTitle></DialogHeader>
              <MediaThumb kind={preview.kind} url={preview.url} controls className="max-h-[60svh] w-full rounded-lg object-contain" />
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Project</dt><dd>{preview.project_name}</dd>
                <dt className="text-muted-foreground">Type</dt><dd>{preview.content_type} · {formatBytes(preview.size_bytes)}</dd>
                {preview.model && <><dt className="text-muted-foreground">Model</dt><dd className="font-mono">{preview.model}</dd></>}
                <dt className="text-muted-foreground">Saved at</dt><dd className="font-mono break-all">{preview.path ?? 'not on disk'}</dd>
              </dl>
              <div className="flex justify-end">
                <Button asChild size="sm"><a href={`${preview.url}?download=1`} download><Download /> Download</a></Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CleanAction({ title, body, onClick, disabled }: { title: string; body: string; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onClick} disabled={disabled}>Clear</Button>
    </div>
  )
}

// ------------------------------------------------------------------ Raw data

function RawTab() {
  const [data, setData] = useState<{ file: string; bytes: number; total_lines: number; entries: LedgerEntry[] } | null>(null)
  const [table, setTable] = useState('all')
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api.ledger(300).then(setData).catch((e) => toast.error(e.message))
  }, [])
  useEffect(load, [load])
  const entries = (data?.entries ?? []).filter((e) => table === 'all' || e.table === table)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Ledger <Hint>A plain-text record of every change (one line each), kept in {data?.file ?? 'ledger.jsonl'}. If the database is ever damaged, the app rebuilds everything from it. Secrets are never shown here.</Hint>
        </CardTitle>
        <CardDescription>
          {data ? <>{data.total_lines} lines · {formatBytes(data.bytes)}. Showing your latest {entries.length}, newest first.</> : 'Loading…'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={table} onValueChange={setTable}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All records</SelectItem>
              <SelectItem value="generations">Generations</SelectItem>
              <SelectItem value="assets">Files</SelectItem>
              <SelectItem value="projects">Projects</SelectItem>
              <SelectItem value="credentials">API key (redacted)</SelectItem>
            </SelectContent>
          </Select>
          <Tip label="Reload"><Button variant="ghost" size="icon" onClick={load} aria-label="Refresh"><RefreshCw /></Button></Tip>
          <Tip label="Rewrite the ledger as one snapshot of your current data. It gets smaller and stays just as safe. The old file is kept in data/backups/.">
            <Button variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                const r = await api.compactLedger()
                toast.success(`Ledger compacted: ${formatBytes(r.bytes_before)} → ${formatBytes(r.bytes_after)}`)
                load()
              } catch (err) {
                toast.error((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}>
              {busy ? <Loader2 className="animate-spin" /> : <Eraser />} Compact ledger
            </Button>
          </Tip>
        </div>
        <ul className="max-h-[560px] divide-y overflow-y-auto rounded-lg border">
          {entries.map((e, i) => (
            <li key={i} className="text-xs">
              <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40">
                <span className="w-36 shrink-0 font-mono text-muted-foreground">{e.ts.replace('T', ' ').replace('Z', '')}</span>
                <Badge variant={e.op === 'delete' ? 'destructive' : 'outline'} className="h-4 px-1.5 text-[10px]">{e.op === 'delete' ? 'deleted' : 'saved'}</Badge>
                <span className="w-24 shrink-0">{e.table}</span>
                <span className="truncate text-muted-foreground">
                  {e.status ?? (e.row?.name as string | undefined) ?? (e.row?.prompt as string | undefined) ?? e.key}
                </span>
              </button>
              {open === i && e.row && <div className="px-3 pb-3"><JsonBlock value={e.row} /></div>}
            </li>
          ))}
          {data && entries.length === 0 && <li className="py-10 text-center text-muted-foreground">No records.</li>}
        </ul>
      </CardContent>
    </Card>
  )
}
