import { useEffect, useState } from 'react'
import { AlertTriangle, Ban, Download, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type Generation } from '@/lib/api'
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
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  '3:4': 'aspect-[3/4]',
  '9:16': 'aspect-[9/16] max-h-[420px] mx-auto',
  '21:9': 'aspect-[21/9]',
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
  const [busy, setBusy] = useState(false)
  const elapsed = useElapsed(g.created_at, g.is_active)
  const st = STATUS[g.status] ?? { label: g.status, tone: 'bg-muted' }
  const refreshable = ['timed_out', 'stalled'].includes(g.status)

  async function act(fn: () => Promise<Generation | void>, ok?: string) {
    setBusy(true)
    try {
      const res = await fn()
      if (res) onUpdate(res)
      if (ok) toast.success(ok)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className={cn('relative w-full bg-black/40', ASPECT_CLASS[g.input.aspect_ratio] ?? 'aspect-video')}>
        {g.status === 'completed' && g.video_url ? (
          <video src={g.video_url} controls playsInline loop className="size-full object-contain" />
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
        <p className="line-clamp-2 text-sm leading-relaxed">{g.input.prompt}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={cn('border-0', st.tone)}>{st.label}</Badge>
          <Badge variant="outline">{g.input.duration}s</Badge>
          <Badge variant="outline">{g.input.resolution}</Badge>
          <Badge variant="outline">{g.input.aspect_ratio}</Badge>
          {g.input.generate_audio && <Badge variant="outline">audio</Badge>}
        </div>
        {(g.request_id || g.correlation_id) && (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {[g.request_id && `req ${g.request_id}`, g.correlation_id && `corr ${g.correlation_id}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </CardContent>

      <CardFooter className="justify-end gap-1 pb-4">
        {g.can_cancel && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.cancel(g.id), 'Canceled')}>
            <X /> Cancel
          </Button>
        )}
        {refreshable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.refresh(g.id))}>
            <RefreshCw className={cn(busy && 'animate-spin')} /> Check again
          </Button>
        )}
        {g.video_url && (
          <Button size="sm" variant="outline" asChild>
            <a href={g.video_url} target="_blank" rel="noreferrer" download>
              <Download /> Open
            </a>
          </Button>
        )}
        {!g.is_active && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label="Remove from history"
                onClick={() => act(async () => { await api.remove(g.id); onRemove(g.id) })}
              >
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from history (does not affect Higgsfield)</TooltipContent>
          </Tooltip>
        )}
      </CardFooter>
    </Card>
  )
}
