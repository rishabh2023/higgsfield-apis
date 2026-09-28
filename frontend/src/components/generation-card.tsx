import { useEffect, useState } from 'react'
import {
  AlertTriangle, Ban, BookmarkCheck, BookmarkPlus, Download, FastForward, Images, Loader2, MoreHorizontal,
  RefreshCw, Shuffle, Trash2, Wand2, X,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import { MediaThumb } from '@/components/media'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, type Generation } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const STATUS: Record<string, { label: string; tone: string }> = {
  submitting: { label: 'Submitting', tone: 'text-sky-300 bg-sky-500/10' },
  queued: { label: 'Queued', tone: 'text-sky-300 bg-sky-500/10' },
  in_progress: { label: 'Generating', tone: 'text-violet-300 bg-violet-500/10' },
  completed: { label: 'Completed', tone: 'text-emerald-300 bg-emerald-500/10' },
  failed: { label: 'Failed', tone: 'text-red-300 bg-red-500/10' },
  nsfw: { label: 'Moderated', tone: 'text-red-300 bg-red-500/10' },
  canceled: { label: 'Canceled', tone: 'text-zinc-300 bg-zinc-500/10' },
  rejected: { label: 'Rejected', tone: 'text-red-300 bg-red-500/10' },
  submission_unknown: { label: 'Outcome unknown', tone: 'text-amber-300 bg-amber-500/10' },
  timed_out: { label: 'Timed out', tone: 'text-amber-300 bg-amber-500/10' },
  stalled: { label: 'Stalled', tone: 'text-amber-300 bg-amber-500/10' },
}

const ASPECT_CLASS: Record<string, string> = {
  '16:9': 'aspect-video', '4:3': 'aspect-[4/3]', '1:1': 'aspect-square',
  '3:4': 'aspect-[3/4]', '9:16': 'aspect-[9/16] max-h-[440px] mx-auto', '21:9': 'aspect-[21/9]',
}

function useElapsed(since: number, active: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [active])
  const s = Math.max(0, Math.floor(now - since))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Props = {
  g: Generation
  onUpdate: (g: Generation) => void
  onRemove: (id: string) => void
}

export function GenerationCard({ g, onUpdate, onRemove }: Props) {
  const { catalog } = useApp()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const elapsed = useElapsed(g.created_at, g.is_active)
  const st = STATUS[g.status] ?? { label: g.status, tone: 'bg-muted' }
  const model = catalog?.models.find((m) => m.id === g.model)
  const mode = catalog?.modes.find((m) => m.id === g.mode)
  const refreshable = ['timed_out', 'stalled'].includes(g.status)
  const out = g.output
  const videoSrc = out?.url ?? g.remote_video_url
  const aspect = (g.params.aspect_ratio as string) ?? '16:9'
  const inputs = Object.values(g.media).flat()

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true)
    try {
      await fn()
      if (ok) toast.success(ok)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const studio = (params: Record<string, string>) =>
    navigate(`/projects/${g.project_id}?${new URLSearchParams({ tab: 'create', ...params })}`)

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className={cn('relative w-full bg-black/40', g.status === 'completed' && videoSrc ? ASPECT_CLASS[aspect] ?? 'aspect-video' : 'aspect-video')}>
        {g.status === 'completed' && videoSrc ? (
          <video src={videoSrc} controls playsInline loop preload="metadata" className="size-full object-contain" />
        ) : g.is_active ? (
          <div className="absolute inset-0 grid place-items-center overflow-hidden">
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-violet-500/10 via-transparent to-sky-500/10" />
            <div className="relative flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <span className="text-sm">{st.label}…</span>
              <span className="font-mono text-xs tabular-nums">{elapsed}</span>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-2 text-sm text-muted-foreground">
              {g.status === 'canceled' ? <Ban className="size-6" /> : <AlertTriangle className="size-6 text-amber-400" />}
              <p className="line-clamp-4">{g.error ?? st.label}</p>
            </div>
          </div>
        )}
      </div>

      <CardContent className="grid gap-2 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={cn('border-0', st.tone)}>{st.label}</Badge>
          <Badge variant="outline">{mode?.name ?? g.mode}</Badge>
          <span className="text-xs text-muted-foreground">{model?.name ?? g.model}</span>
        </div>
        {g.prompt ? (
          <p className="line-clamp-2 text-sm leading-relaxed">{g.prompt}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">No prompt</p>
        )}
        {inputs.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-hidden">
            {inputs.slice(0, 5).map((a) => (
              <div key={a.id} title={a.name} className="size-8 shrink-0 overflow-hidden rounded border">
                <MediaThumb kind={a.kind} url={a.url} className="size-full" />
              </div>
            ))}
            <span className="truncate text-xs text-muted-foreground">
              {inputs.length} input{inputs.length > 1 ? 's' : ''}
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {Object.entries(g.params).map(([k, v]) => (
            <Badge key={k} variant="outline" className="font-normal text-muted-foreground">
              {k === 'duration' ? `${v}s` : typeof v === 'boolean' ? (v ? k.replace('generate_', '') : `no ${k.replace('generate_', '')}`) : String(v)}
            </Badge>
          ))}
        </div>
        {out?.status === 'downloading' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Saving a copy to this computer…
          </p>
        )}
        {out?.status === 'download_failed' && (
          <p className="text-xs text-amber-300">
            {out.error} Playing from Higgsfield for now.{' '}
            <button className="underline" onClick={() => act(async () => onUpdate({ ...g, output: await api.retryDownload(out.id) }))}>
              Retry
            </button>
          </p>
        )}
      </CardContent>

      <CardFooter className="flex-wrap justify-end gap-1 pb-4">
        {g.can_cancel && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(async () => onUpdate(await api.cancel(g.id)), 'Canceled')}>
            <X /> Cancel
          </Button>
        )}
        {refreshable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(async () => onUpdate(await api.refresh(g.id)))}>
            <RefreshCw className={cn(busy && 'animate-spin')} /> Check again
          </Button>
        )}
        {['failed', 'nsfw', 'rejected', 'canceled'].includes(g.status) && (
          <Button size="sm" variant="outline" onClick={() => studio({ from: g.id })}>
            <Shuffle /> Try another model
          </Button>
        )}
        {out && g.status === 'completed' && (
          <>
            <Button size="sm" asChild title="Download the MP4 to your computer">
              <a href={`${out.url}?download=1`} download><Download /> Download</a>
            </Button>
            <Button size="sm" variant="outline" onClick={() => studio({ mode: 'edit', source: out.id })}>
              <Wand2 /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => studio({ mode: 'extend', source: out.id })}>
              <FastForward /> Extend
            </Button>
          </>
        )}
        {!g.is_active && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions" disabled={busy}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {out && g.status === 'completed' && (
                <>
                  <DropdownMenuItem onClick={() => studio({ mode: 'reference', ref: out.id })}>
                    <Images /> Use as reference
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => act(async () => {
                    const a = await api.updateAsset(out.id, { in_library: !out.in_library })
                    onUpdate({ ...g, output: a })
                  }, out.in_library ? 'Removed from references' : 'Added to references')}>
                    {out.in_library ? <><BookmarkCheck /> Remove from references</> : <><BookmarkPlus /> Add to references</>}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => studio({ from: g.id })}>
                <Shuffle /> Try another model
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => act(async () => {
                await api.removeGeneration(g.id)
                onRemove(g.id)
              }, 'Removed')}>
                <Trash2 /> Remove from project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardFooter>
      {(g.request_id || g.correlation_id) && (
        <p className="truncate border-t px-4 py-2 font-mono text-[10px] text-muted-foreground/70">
          {[g.request_id && `req ${g.request_id}`, g.correlation_id && `corr ${g.correlation_id}`].filter(Boolean).join(' · ')}
        </p>
      )}
    </Card>
  )
}
