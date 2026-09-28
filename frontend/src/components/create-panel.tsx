import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FastForward, Film, ImageIcon, Images, Info, Loader2, Plus, Sparkles, Type, Wand2, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'

import { AssetPicker, KIND_ICON, MediaThumb } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  ApiError, api, newIdempotencyKey, type Asset, type AssetBrief, type Generation, type MediaSlot, type ModeId,
  type ModelSpec,
} from '@/lib/api'
import { canGenerate, useApp } from '@/lib/app-context'

type Picked = Record<string, AssetBrief[]>

const MODE_TAB: Record<ModeId, { label: string; icon: typeof Film }> = {
  text: { label: 'Text', icon: Type },
  image: { label: 'Image', icon: ImageIcon },
  reference: { label: 'References', icon: Images },
  edit: { label: 'Edit', icon: Wand2 },
  extend: { label: 'Extend', icon: FastForward },
}

const PLACEHOLDER: Record<ModeId, string> = {
  text: 'A cinematic tracking shot along a sunlit coastal road, golden hour',
  image: 'Optional: describe the motion, e.g. "slow push-in, hair blowing in the wind"',
  reference: 'Describe the new video and how to use the references, e.g. "the character from the image walks through the street from the video"',
  edit: 'Describe the change, e.g. "make it snow and turn the car red"',
  extend: 'Describe what happens next, e.g. "the car drives into a tunnel"',
}

function defaults(m: ModelSpec): Record<string, unknown> {
  return Object.fromEntries(m.params.map((p) => [p.name, p.default]))
}

/** Keep selected media that the new model also accepts (same slot name + kind), trimmed to its limits. */
function carryMedia(prev: Picked, m: ModelSpec, prevModel?: ModelSpec): Picked {
  const next: Picked = {}
  for (const s of m.media) {
    const items = (prev[s.name] ?? []).filter((a) => a.kind === s.kind)
    if (items.length) next[s.name] = items.slice(0, s.multiple ? s.max : 1)
  }
  // The source video keeps its role even when models name the field differently
  // (e.g. Seedance `video_url` vs Kling `video_urls`).
  const oldSource = prevModel?.media.find((s) => s.required && prev[s.name]?.length)
  const newSource = m.media.find((s) => s.required && oldSource && s.kind === oldSource.kind)
  if (oldSource && newSource && !next[newSource.name]?.length) {
    next[newSource.name] = prev[oldSource.name].slice(0, newSource.multiple ? newSource.max : 1)
    if (newSource.name !== oldSource.name && next[oldSource.name]) delete next[oldSource.name]
  }
  return next
}

function toBrief(a: Asset): AssetBrief {
  return { id: a.id, name: a.name, kind: a.kind, url: a.url }
}

export function CreatePanel({ projectId, onCreated }: { projectId: string; onCreated: (g: Generation) => void }) {
  const { catalog, credential } = useApp()
  const [search, setSearch] = useSearchParams()
  const [mode, setMode] = useState<ModeId>('text')
  const [modelId, setModelId] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [media, setMedia] = useState<Picked>({})
  const [picking, setPicking] = useState<MediaSlot | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Rotated only after the server answers, so a retry after a dropped connection is deduplicated.
  const idemKey = useRef(newIdempotencyKey())

  const models = useMemo(() => catalog?.models.filter((m) => m.mode === mode) ?? [], [catalog, mode])
  const model = catalog?.models.find((m) => m.id === modelId) ?? models[0]

  function selectModel(m: ModelSpec, keepMedia: Picked, prev?: ModelSpec) {
    setModelId(m.id)
    setParams(defaults(m))
    setMedia(carryMedia(keepMedia, m, prev))
  }

  function selectMode(next: ModeId, seed: Picked = media) {
    const m = catalog?.models.find((x) => x.mode === next)
    setMode(next)
    if (m) selectModel(m, seed)
  }

  // Initial model + deep links from video cards: ?mode=edit&source=<asset> or ?mode=reference&ref=<asset>
  useEffect(() => {
    if (!catalog) return
    const wantMode = search.get('mode') as ModeId | null
    const source = search.get('source')
    const ref = search.get('ref')
    if (!wantMode) {
      if (!modelId) selectMode('text', {})
      return
    }
    const id = source ?? ref
    const apply = (a?: Asset) => {
      const seed: Picked = {}
      if (a) {
        const m = catalog.models.find((x) => x.mode === wantMode)
        const slot = source
          ? m?.media.find((s) => s.kind === a.kind && s.required)
          : m?.media.find((s) => s.kind === a.kind)
        if (slot) seed[slot.name] = [toBrief(a)]
      }
      selectMode(wantMode, seed)
      setSearch((p) => {
        p.delete('mode')
        p.delete('source')
        p.delete('ref')
        return p
      }, { replace: true })
    }
    if (id) api.assets(projectId, 'all').then((all) => apply(all.find((a) => a.id === id))).catch(() => apply())
    else apply()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, search])

  if (!catalog || !model) {
    return <Card className="h-96 animate-pulse" />
  }

  const ready = canGenerate(credential)
  const promptTooLong = prompt.length > model.prompt_max
  const missing = model.media.filter((s) => s.required && !(media[s.name]?.length))
  const needsOneOf = model.require_one_of.length > 0 && !model.require_one_of.some((n) => media[n]?.length)
  const valid = (!model.prompt_required || prompt.trim()) && !promptTooLong && !missing.length && !needsOneOf

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!model || submitting || !valid) return
    setSubmitting(true)
    try {
      const g = await api.generate(projectId, {
        model: model.id,
        prompt: prompt.trim() || null,
        params,
        media: Object.fromEntries(Object.entries(media).map(([k, v]) => [k, v.map((a) => a.id)])),
      }, idemKey.current)
      idemKey.current = newIdempotencyKey()
      onCreated(g)
      if (g.status === 'rejected') toast.error(g.error ?? 'Higgsfield rejected the request')
      else if (g.status === 'submission_unknown') toast.warning('Submission outcome unknown — not retried automatically')
      else toast.success('Queued on Higgsfield')
    } catch (err) {
      if (err instanceof ApiError) idemKey.current = newIdempotencyKey()
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <ToggleGroup type="single" variant="outline" value={mode} className="flex w-full flex-wrap"
        onValueChange={(v) => v && selectMode(v as ModeId)}>
        {catalog.modes.map((m) => {
          const { label, icon: Icon } = MODE_TAB[m.id]
          return (
            <ToggleGroupItem key={m.id} value={m.id} title={m.name} className="flex-1 gap-1.5 px-2 text-xs sm:text-sm">
              <Icon className="size-3.5" /> {label}
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>

      <Card>
        <CardHeader>
          <CardTitle>{catalog.modes.find((m) => m.id === mode)?.name}</CardTitle>
          <CardDescription>{catalog.modes.find((m) => m.id === mode)?.description}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label>Model</Label>
            <div className="flex gap-2">
              <Select value={model.id} onValueChange={(id) => {
                const m = catalog.models.find((x) => x.id === id)
                if (m) selectModel(m, media, model)
              }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button asChild variant="ghost" size="icon" aria-label="Model documentation">
                <a href={model.docs} target="_blank" rel="noreferrer"><ExternalLink /></a>
              </Button>
            </div>
            {model.notes.map((n) => (
              <p key={n} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" /> {n}
              </p>
            ))}
          </div>

          {model.media.map((slot) => (
            <SlotField key={slot.name} slot={slot} items={media[slot.name] ?? []}
              onPick={() => setPicking(slot)}
              onRemove={(id) => setMedia((p) => ({ ...p, [slot.name]: (p[slot.name] ?? []).filter((a) => a.id !== id) }))} />
          ))}
          {needsOneOf && (
            <p className="-mt-2 text-xs text-amber-300/90">
              Add at least one: {model.require_one_of.map((n) => model.media.find((s) => s.name === n)?.label.toLowerCase()).join(' or ')}.
            </p>
          )}

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="prompt">
                Prompt {!model.prompt_required && <span className="font-normal text-muted-foreground">(optional)</span>}
              </Label>
              <span className={`text-xs tabular-nums ${promptTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
                {prompt.length}/{model.prompt_max}
              </span>
            </div>
            <Textarea id="prompt" rows={4} className="resize-none" placeholder={PLACEHOLDER[mode]} value={prompt}
              onChange={(e) => setPrompt(e.target.value)} />
          </div>

          <ParamFields model={model} params={params} setParam={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button type="submit" size="lg" disabled={!ready || submitting || !valid}>
            {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitting ? (model.media.length ? 'Preparing files & submitting…' : 'Submitting…') : 'Generate'}
          </Button>
          {!ready && (
            <p className="text-center text-xs text-muted-foreground">
              <Link to="/settings" className="underline underline-offset-4">Add your API key in Settings</Link> to start generating.
            </p>
          )}
        </CardFooter>
      </Card>

      {picking && (
        <AssetPicker open={!!picking} onOpenChange={(v) => !v && setPicking(null)} projectId={projectId}
          kind={picking.kind} max={picking.multiple ? picking.max : 1}
          selected={(media[picking.name] ?? []).map((a) => a.id)}
          onConfirm={(_ids, assets) => setMedia((p) => ({ ...p, [picking.name]: assets.map(toBrief) }))} />
      )}
    </form>
  )
}

function SlotField({ slot, items, onPick, onRemove }: {
  slot: MediaSlot
  items: AssetBrief[]
  onPick: () => void
  onRemove: (id: string) => void
}) {
  const Icon = KIND_ICON[slot.kind]
  const limit = slot.multiple ? slot.max : 1
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <Label>
          {slot.label} {slot.required && <span className="text-violet-300">*</span>}
        </Label>
        <span className="text-xs text-muted-foreground">{items.length}/{limit}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <div key={a.id} className="group relative w-28 overflow-hidden rounded-lg border" title={a.name}>
            <MediaThumb kind={a.kind} url={a.url} className="aspect-video w-full" />
            <p className="truncate px-1.5 py-1 text-[11px]">{a.name}</p>
            <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100">
              <X className="size-3" />
            </button>
          </div>
        ))}
        {items.length < limit && (
          <button type="button" onClick={onPick}
            className="flex aspect-[28/22] w-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground transition hover:bg-accent/40 hover:text-foreground">
            <span className="flex items-center gap-1"><Plus className="size-3.5" /><Icon className="size-3.5" /></span>
            {items.length ? 'Add more' : `Choose ${slot.kind}`}
          </button>
        )}
      </div>
      {slot.help && <p className="text-xs text-muted-foreground">{slot.help}</p>}
    </div>
  )
}

function ParamFields({ model, params, setParam }: {
  model: ModelSpec
  params: Record<string, unknown>
  setParam: (k: string, v: unknown) => void
}) {
  const ints = model.params.filter((p) => p.type === 'int')
  const enums = model.params.filter((p) => p.type === 'enum')
  const bools = model.params.filter((p) => p.type === 'bool')
  return (
    <>
      {ints.map((p) => (
        <div key={p.name} className="grid gap-3">
          <div className="flex items-baseline justify-between">
            <Label>{p.label}</Label>
            <span className="font-mono text-sm tabular-nums">{String(params[p.name] ?? p.default)}{p.name === 'duration' && 's'}</span>
          </div>
          <Slider min={p.min ?? 0} max={p.max ?? 100} step={1} value={[Number(params[p.name] ?? p.default)]}
            onValueChange={([v]) => setParam(p.name, v)} />
        </div>
      ))}
      {enums.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {enums.map((p) => (
            <div key={p.name} className="grid gap-2">
              <Label>{p.label}</Label>
              <Select value={String(params[p.name] ?? p.default)} onValueChange={(v) => setParam(p.name, v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {p.options?.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
      {bools.map((p) => (
        <div key={p.name} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div className="grid gap-0.5">
            <Label htmlFor={p.name}>{p.label}</Label>
            {p.help && <span className="text-xs text-muted-foreground">{p.help}</span>}
          </div>
          <Switch id={p.name} checked={Boolean(params[p.name] ?? p.default)} onCheckedChange={(v) => setParam(p.name, v)} />
        </div>
      ))}
    </>
  )
}
