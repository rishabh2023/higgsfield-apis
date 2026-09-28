import { useEffect, useRef, useState } from 'react'
import { AudioLines, Check, Film, ImageIcon, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type Asset, type MediaKind } from '@/lib/api'
import { cn } from '@/lib/utils'

export const KIND_ICON = { image: ImageIcon, video: Film, audio: AudioLines } as const

export const ACCEPT: Record<MediaKind, string> = {
  image: 'image/jpeg,image/png,image/webp,image/gif',
  video: 'video/mp4',
  audio: 'audio/wav,audio/x-wav',
}
const ACCEPT_ALL = Object.values(ACCEPT).join(',')

/** Square-ish preview for any asset. */
export function MediaThumb({ kind, url, className, controls = false }: {
  kind: MediaKind | null
  url: string | null
  className?: string
  controls?: boolean
}) {
  const Icon = KIND_ICON[kind ?? 'video']
  if (!url || !kind) {
    return (
      <div className={cn('grid place-items-center bg-muted/40', className)}>
        <Icon className="size-5 text-muted-foreground" />
      </div>
    )
  }
  if (kind === 'image') return <img src={url} alt="" loading="lazy" className={cn('object-cover', className)} />
  if (kind === 'video') {
    return (
      <video
        src={url}
        muted={!controls}
        controls={controls}
        playsInline
        preload="metadata"
        className={cn('bg-black object-cover', className)}
        onMouseEnter={(e) => !controls && e.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(e) => !controls && e.currentTarget.pause()}
      />
    )
  }
  return (
    <div className={cn('grid place-items-center gap-2 bg-muted/40 p-3', className)}>
      <AudioLines className="size-6 text-muted-foreground" />
      {controls && <audio src={url} controls className="w-full" />}
    </div>
  )
}

/** Upload one or more files into a project's reference library. */
export function useUploader(projectId: string, onUploaded: (a: Asset) => void) {
  const [busy, setBusy] = useState(0)
  async function uploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setBusy((n) => n + 1)
      try {
        onUploaded(await api.upload(projectId, f))
      } catch (err) {
        toast.error(`${f.name}: ${(err as Error).message}`)
      } finally {
        setBusy((n) => n - 1)
      }
    }
  }
  return { busy: busy > 0, uploadFiles }
}

export function Dropzone({ projectId, onUploaded, accept = ACCEPT_ALL, compact = false }: {
  projectId: string
  onUploaded: (a: Asset) => void
  accept?: string
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const { busy, uploadFiles } = useUploader(projectId, onUploaded)

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        uploadFiles(e.dataTransfer.files)
      }}
      onClick={() => input.current?.click()}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-center transition-colors hover:bg-accent/40',
        compact ? 'px-4 py-5' : 'px-6 py-10',
        over && 'border-violet-400 bg-violet-500/5',
      )}
    >
      <input ref={input} type="file" multiple accept={accept} hidden
        onChange={(e) => e.target.files && uploadFiles(e.target.files).finally(() => (e.target.value = ''))} />
      {busy ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <Upload className="size-5 text-muted-foreground" />}
      <p className="text-sm font-medium">{busy ? 'Uploading…' : 'Drop files or click to upload'}</p>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Images: JPG, PNG, WEBP, GIF (≤30 MB) · Video: MP4 (≤200 MB) · Audio: WAV (≤50 MB)
        </p>
      )}
    </div>
  )
}

/** Pick assets of one kind from the project's references and generated videos. */
export function AssetPicker({ open, onOpenChange, projectId, kind, max, selected, onConfirm }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  kind: MediaKind
  max: number
  selected: string[]
  onConfirm: (ids: string[], assets: Asset[]) => void
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [picked, setPicked] = useState<string[]>(selected)

  useEffect(() => {
    if (!open) return
    setPicked(selected)
    setAssets(null)
    api.assets(projectId, 'all').then(setAssets).catch((e) => toast.error(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload each time the dialog opens
  }, [open, projectId])

  const usable = (assets ?? []).filter((a) => a.kind === kind && (a.in_library || a.source === 'generation'))
  const refs = usable.filter((a) => a.source === 'upload' || a.in_library)
  const outputs = usable.filter((a) => a.source === 'generation' && !a.in_library)

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : max === 1 ? [id] : p.length >= max ? p : [...p, id]))
  }

  const section = (title: string, items: Asset[]) =>
    items.length > 0 && (
      <div className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((a) => {
            const on = picked.includes(a.id)
            return (
              <button type="button" key={a.id} onClick={() => toggle(a.id)} title={a.name}
                className={cn('relative overflow-hidden rounded-lg border-2 text-left transition',
                  on ? 'border-violet-400' : 'border-transparent hover:border-foreground/20')}>
                <MediaThumb kind={a.kind} url={a.url} className="aspect-video w-full" />
                <p className="truncate px-1.5 py-1 text-xs">{a.name}</p>
                {on && (
                  <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-violet-500 text-white">
                    <Check className="size-3" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose {kind === 'audio' ? 'audio' : `${kind}s`}</DialogTitle>
          <DialogDescription>
            {max === 1 ? 'Select one.' : `Select up to ${max}.`} Upload new files here or pick from this project.
          </DialogDescription>
        </DialogHeader>
        <Dropzone compact projectId={projectId} accept={ACCEPT[kind]} onUploaded={(a) => {
          setAssets((prev) => [a, ...(prev ?? [])])
          if (a.kind === kind) toggle(a.id)
        }} />
        {assets === null ? (
          <div className="grid place-items-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : usable.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No {kind} files in this project yet.</p>
        ) : (
          <>
            {section('References', refs)}
            {section('Generated videos', outputs)}
          </>
        )}
        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">{picked.length} selected</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => {
            onConfirm(picked, (assets ?? []).filter((a) => picked.includes(a.id)))
            onOpenChange(false)
          }}>Use selected</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
