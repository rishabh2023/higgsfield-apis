import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Coins, ExternalLink, FastForward, Film, ImageIcon, Images, Info, Lightbulb, Loader2, Mic, Plus, Sparkles, Square, Type, Wand2, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'

import { AssetPicker, KIND_ICON, MediaThumb } from '@/components/media'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Hint, Tip } from '@/components/hint'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiError, api, newIdempotencyKey, type Asset, type AssetBrief, type Estimate, type Generation, type MediaSlot, type ModeId,
  type ModelSpec,
} from '@/lib/api'
import { canGenerate, useApp } from '@/lib/app-context'
import { isCreditError, MODE_HELP, PARAM_HELP, PROMPT_CHIPS, PROMPT_HELP, TOP_UP_URL } from '@/lib/help'
import { SPEECH_LANGS, useSpeech } from '@/lib/use-speech'
import { cn } from '@/lib/utils'

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

type Draft = {
  mode: ModeId
  modelId: string
  prompt: string
  params: Record<string, unknown>
  media: Picked
  idemKey: string
}

// The in-progress form (and its pending request key) survives refreshes, so work isn't lost
// and re-clicking Generate after a refresh can't pay for the same video twice.
const draftKey = (projectId: string) => `vs:draft:${projectId}`
function loadDraft(projectId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(projectId))
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}
function saveDraft(projectId: string, d: Draft) {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(d))
  } catch {
    /* storage full or blocked: the form still works, it just won't survive a refresh */
  }
}

function readLang(): string {
  try {
    return localStorage.getItem('vs:speech-lang') ?? navigator.language ?? 'en-US'
  } catch {
    return 'en-US'
  }
}

type Duplicate = { generation_id: string; status: string; message: string }

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
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [lang, setLang] = useState(readLang)
  // Rotated only after the server answers, so a retry after a dropped connection is deduplicated.
  const idemKey = useRef(newIdempotencyKey())
  const speech = useSpeech(setPrompt, (msg) => toast.error(msg))

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

  // Initial state, in priority order:
  //   ?from=<generation>             "Try another model": same prompt, settings and files
  //   ?mode=edit&source=<asset> | ?mode=reference&ref=<asset>   actions on video cards
  //   saved draft for this project   survives page refresh
  useEffect(() => {
    if (!catalog) return
    const from = search.get('from')
    const wantMode = search.get('mode') as ModeId | null
    const source = search.get('source')
    const ref = search.get('ref')
    const clearLink = () => setSearch((p) => {
      for (const k of ['mode', 'source', 'ref', 'from']) p.delete(k)
      return p
    }, { replace: true })

    if (from) {
      api.generation(from).then((g) => {
        const m = catalog.models.find((x) => x.id === g.model)
        if (!m) return
        setMode(g.mode)
        setModelId(m.id)
        setPrompt(g.prompt ?? '')
        setParams({ ...defaults(m), ...g.params })
        setMedia(Object.fromEntries(Object.entries(g.media).map(([k, v]) => [k, v.filter((a) => a.url)])))
        toast.info('Settings copied. Pick another model and generate.')
      }).catch((e) => toast.error(e.message)).finally(() => {
        setInitialized(true)
        clearLink()
      })
      return
    }
    if (!wantMode) {
      if (!initialized) {
        const d = loadDraft(projectId)
        const m = d && catalog.models.find((x) => x.id === d.modelId)
        if (d && m) {
          setMode(d.mode)
          setModelId(m.id)
          setPrompt(d.prompt)
          setParams({ ...defaults(m), ...d.params })
          setMedia(d.media)
          idemKey.current = d.idemKey || idemKey.current
        } else {
          selectMode('text', {})
        }
        setInitialized(true)
      }
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
      setInitialized(true)
      clearLink()
    }
    if (id) api.assets(projectId, 'all').then((all) => apply(all.find((a) => a.id === id))).catch(() => apply())
    else apply()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, search])

  useEffect(() => {
    if (initialized && modelId) saveDraft(projectId, { mode, modelId, prompt, params, media, idemKey: idemKey.current })
  }, [initialized, projectId, mode, modelId, prompt, params, media])

  // Live price preview (debounced). Prompt text doesn't change the price, so it isn't a dependency.
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const mediaKey = JSON.stringify(Object.fromEntries(Object.entries(media).map(([k, v]) => [k, v.map((a) => a.id)])))
  const hasPrompt = prompt.trim().length > 0
  useEffect(() => {
    if (!model || !canGenerate(credential)) {
      setEstimate(null)
      return
    }
    setEstimating(true)
    const t = setTimeout(() => {
      api.estimate({ model: model.id, prompt: hasPrompt ? 'x' : null, params, media: JSON.parse(mediaKey) })
        .then(setEstimate)
        .catch(() => setEstimate(null))
        .finally(() => setEstimating(false))
    }, 600)
    return () => clearTimeout(t)
  }, [model, params, mediaKey, hasPrompt, credential])

  if (!catalog || !model) {
    return <Card className="h-96 animate-pulse" />
  }

  const ready = canGenerate(credential)
  const promptTooLong = prompt.length > model.prompt_max
  const missing = model.media.filter((s) => s.required && !(media[s.name]?.length))
  const needsOneOf = model.require_one_of.length > 0 && !model.require_one_of.some((n) => media[n]?.length)
  const valid = (!model.prompt_required || prompt.trim()) && !promptTooLong && !missing.length && !needsOneOf

  async function send(allowDuplicate: boolean) {
    if (!model || submitting || !valid) return
    speech.stop()
    setSubmitting(true)
    try {
      const g = await api.generate(projectId, {
        model: model.id,
        prompt: prompt.trim() || null,
        params,
        media: Object.fromEntries(Object.entries(media).map(([k, v]) => [k, v.map((a) => a.id)])),
        allow_duplicate: allowDuplicate,
      }, idemKey.current)
      idemKey.current = newIdempotencyKey()
      saveDraft(projectId, { mode, modelId: model.id, prompt, params, media, idemKey: idemKey.current })
      onCreated(g)
      if (g.status === 'rejected' && isCreditError(g.error)) {
        toast.error('Not enough Higgsfield credits', {
          description: 'Top up your balance, then click Generate again. Nothing was charged.',
          action: { label: 'Top up', onClick: () => window.open(TOP_UP_URL, '_blank', 'noopener') },
          duration: 12000,
        })
      } else if (g.status === 'rejected') toast.error(g.error ?? 'Higgsfield rejected the request')
      else if (g.status === 'submission_unknown') toast.warning('Submission outcome unknown — not retried automatically')
      else toast.success('Queued on Higgsfield')
    } catch (err) {
      const detail = err instanceof ApiError ? (err.detail as Partial<Duplicate> & { code?: string }) : null
      if (detail?.code === 'duplicate' && detail.generation_id) {
        setDuplicate(detail as Duplicate)
      } else {
        if (err instanceof ApiError) idemKey.current = newIdempotencyKey()
        toast.error((err as Error).message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    send(false)
  }

  const modeHelp = MODE_HELP[mode]
  const durationParam = params.duration as number | undefined
  const summary = [
    model.name,
    mode === 'extend' && durationParam ? `+${durationParam}s` : durationParam ? `${durationParam}s` : null,
    params.resolution as string | undefined,
    params.aspect_ratio as string | undefined,
  ].filter(Boolean).join(' · ')
  const requiredSlots = model.media.filter((s) => s.required)
  const optionalSlots = model.media.filter((s) => !s.required)
  const optionalCount = optionalSlots.reduce((n, s) => n + (media[s.name]?.length ?? 0), 0)

  function addChip(text: string) {
    setPrompt((p) => (p.trim() ? `${p.trim().replace(/[.,]$/, '')}, ${text}` : text.charAt(0).toUpperCase() + text.slice(1)))
  }
  const slotField = (slot: MediaSlot) => (
    <SlotField key={slot.name} slot={slot} items={media[slot.name] ?? []}
      onPick={() => setPicking(slot)}
      onRemove={(id) => setMedia((p) => ({ ...p, [slot.name]: (p[slot.name] ?? []).filter((a) => a.id !== id) }))} />
  )

  return (
    <form onSubmit={submit} className="grid gap-3"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          send(false)
        }
      }}>
      <Card className="gap-0 overflow-hidden py-0">
        {/* Mode switcher */}
        <div className="flex gap-0.5 border-b bg-muted/20 p-1">
          {catalog.modes.map((m) => {
            const { label, icon: Icon } = MODE_TAB[m.id]
            const active = m.id === mode
            return (
              <Tip key={m.id} side="bottom" label={<><b>{m.name}</b>: {MODE_HELP[m.id].how}</>}>
                <button type="button" onClick={() => selectMode(m.id)} aria-pressed={active}
                  className={cn(
                    'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition',
                    active ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                  )}>
                  <Icon className={cn('size-3.5', active && 'text-violet-300')} />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              </Tip>
            )
          })}
        </div>

        <CardContent className="grid gap-4 p-4">
          {/* What this mode does, in one line */}
          <div className="flex items-start gap-2 rounded-md bg-violet-500/[0.06] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0 text-violet-300" />
            <p>
              <span className="font-medium text-foreground">{modeHelp.tagline}.</span> {modeHelp.how}
            </p>
          </div>

          <Field label="Model" hint="Different AI models give different looks, lengths and prices. Switching keeps your prompt and files.">
            <div className="flex gap-1.5">
              <Select value={model.id} onValueChange={(id) => {
                const m = catalog.models.find((x) => x.id === id)
                if (m) selectModel(m, media, model)
              }}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Tip label="Open this model’s official documentation">
                <Button asChild variant="ghost" size="icon-sm" aria-label="Model documentation">
                  <a href={model.docs} target="_blank" rel="noreferrer"><ExternalLink /></a>
                </Button>
              </Tip>
            </div>
            {model.notes.length > 0 && <p className="text-[11px] text-muted-foreground">{model.notes.join(' ')}</p>}
          </Field>

          {requiredSlots.map(slotField)}

          {optionalSlots.length > 0 && (
            <details className="group rounded-md border" open={optionalCount > 0 || mode === 'reference'}>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium select-none">
                <ChevronRight className="size-3.5 text-muted-foreground transition group-open:rotate-90" />
                {mode === 'reference' ? 'Reference files' : 'Extra references'}
                <span className="text-muted-foreground">{mode === 'reference' ? '(add at least one)' : '(optional)'}</span>
                <Hint>Images, clips or audio the AI should take inspiration from, like a character, an object, a motion or a sound.</Hint>
                {optionalCount > 0 && <Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[10px]">{optionalCount}</Badge>}
              </summary>
              <div className="grid gap-3 border-t px-3 py-3">
                {optionalSlots.map(slotField)}
                {needsOneOf && (
                  <p className="text-[11px] text-amber-300/90">
                    Add at least one: {model.require_one_of.map((n) => model.media.find((x) => x.name === n)?.label.toLowerCase()).join(' or ')}.
                  </p>
                )}
              </div>
            </details>
          )}

          <Field label={<>Prompt {!model.prompt_required && <span className="font-normal text-muted-foreground">(optional)</span>}</>}
            hint={PROMPT_HELP}
            aside={<span className={`text-[11px] tabular-nums ${promptTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{prompt.length}/{model.prompt_max}</span>}>
            <div className={cn('rounded-md border bg-input/20 transition focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50', speech.listening && 'border-red-400/60')}>
              <Textarea id="prompt" rows={3} className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder={PLACEHOLDER[mode]} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              <div className="flex items-center gap-1 border-t px-1.5 py-1">
                <details className="group/ideas relative">
                  <summary className="flex h-6 cursor-pointer list-none items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground select-none hover:text-foreground">
                    <Lightbulb className="size-3" /> Ideas
                  </summary>
                  <div className="absolute z-20 mt-1 grid w-[min(380px,85vw)] gap-1.5 rounded-md border bg-popover p-2 shadow-lg">
                    {PROMPT_CHIPS.map((g) => (
                      <div key={g.group} className="flex flex-wrap items-center gap-1">
                        <span className="w-12 text-[10px] text-muted-foreground uppercase">{g.group}</span>
                        {g.items.map((t) => (
                          <button key={t} type="button" onClick={() => addChip(t)}
                            className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-violet-400/50 hover:bg-violet-500/10 hover:text-foreground">
                            + {t}
                          </button>
                        ))}
                      </div>
                    ))}
                    <p className="text-[10px] text-muted-foreground/80">e.g. {modeHelp.example}</p>
                  </div>
                </details>
                {prompt && !speech.listening && (
                  <Tip label="Clear the prompt">
                    <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" onClick={() => setPrompt('')} aria-label="Clear prompt"><X /></Button>
                  </Tip>
                )}
                {speech.listening && (
                  <span className="flex items-center gap-1.5 text-[11px] text-red-300">
                    <span className="size-1.5 animate-pulse rounded-full bg-red-400" /> Listening…
                  </span>
                )}
                {speech.supported && (
                  <div className="ml-auto flex items-center gap-1">
                    <Tip label="Language you’ll speak in">
                      <span>
                        <Select value={lang} onValueChange={(v) => {
                          setLang(v)
                          try { localStorage.setItem('vs:speech-lang', v) } catch { /* ignore */ }
                        }}>
                          <SelectTrigger size="sm" className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none dark:bg-transparent" aria-label="Dictation language">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {!SPEECH_LANGS.some((l) => l.code === lang) && <SelectItem value={lang}>{lang}</SelectItem>}
                            {SPEECH_LANGS.map((l) => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </span>
                    </Tip>
                    <Tip label={speech.listening ? 'Stop listening' : 'Speak your prompt instead of typing. Uses your browser’s free speech recognition. The first time, allow the microphone.'}>
                      <Button type="button" size="xs" variant={speech.listening ? 'destructive' : 'secondary'}
                        onClick={() => (speech.listening ? speech.stop() : speech.start(prompt, lang))}>
                        {speech.listening ? <><Square className="fill-current" /> Stop</> : <><Mic /> Speak</>}
                      </Button>
                    </Tip>
                  </div>
                )}
              </div>
            </div>
          </Field>

          {model.params.length > 0 && (
            <ParamFields model={model} params={params} setParam={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
          )}
        </CardContent>

        <CardFooter className="grid gap-2 border-t bg-muted/10 p-3">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-muted-foreground">{summary}</span>
            <CostPill estimate={estimate} loading={estimating} ready={ready} />
          </div>
          <Tip label={ready ? 'Send to Higgsfield. Shortcut: ⌘/Ctrl + Enter. Uses credits from your Higgsfield account.' : 'Add your API key in Settings first'}>
            <span className="grid">
              <Button type="submit" disabled={!ready || submitting || !valid}>
                {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {submitting ? (model.media.length ? 'Preparing files & submitting…' : 'Submitting…') : 'Generate'}
                {!submitting && <kbd className="ml-1 hidden rounded border border-current/30 px-1 text-[10px] opacity-60 sm:inline">⌘↵</kbd>}
              </Button>
            </span>
          </Tip>
          {!ready && (
            <p className="text-center text-[11px] text-muted-foreground">
              <Link to="/settings" className="underline underline-offset-4">Add your API key in Settings</Link> to start generating.
            </p>
          )}
        </CardFooter>
      </Card>

      <AlertDialog open={!!duplicate} onOpenChange={(v) => !v && setDuplicate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Already made this video</AlertDialogTitle>
            <AlertDialogDescription>
              {duplicate?.message} Generating again will use Higgsfield credits and give a new variation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the existing one</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setDuplicate(null)
              send(true)
            }}>Generate again (uses credits)</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {picking && (
        <AssetPicker open={!!picking} onOpenChange={(v) => !v && setPicking(null)} projectId={projectId}
          kind={picking.kind} max={picking.multiple ? picking.max : 1}
          selected={(media[picking.name] ?? []).map((a) => a.id)}
          onConfirm={(_ids, assets) => setMedia((p) => ({ ...p, [picking.name]: assets.map(toBrief) }))} />
      )}
    </form>
  )
}

function CostPill({ estimate, loading, ready }: { estimate: Estimate | null; loading: boolean; ready: boolean }) {
  if (!ready) return null
  if (loading && !estimate) return <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" /> pricing…</span>
  if (!estimate) return null
  if (!estimate.available) {
    return (
      <Tip label={`${estimate.reason} The exact cost is always shown in your Higgsfield Console.`}>
        <span className="cursor-help text-muted-foreground">price n/a</span>
      </Tip>
    )
  }
  return (
    <Tip label="Estimated cost from Higgsfield for these settings. Failed or blocked videos are not charged.">
      <span className={cn('flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 font-medium tabular-nums', loading && 'opacity-60')}>
        <Coins className="size-3 text-amber-300" /> ≈ {estimate.credits} credits
        <span className="text-muted-foreground">(${estimate.usd.toFixed(2)})</span>
      </span>
    </Tip>
  )
}

function Field({ label, hint, aside, children }: {
  label: React.ReactNode
  hint: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{label}</span>
        <Hint>{hint}</Hint>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </div>
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
  const explain = slot.required
    ? `Required. The ${slot.kind} the model works on.`
    : `Optional. Up to ${limit} ${slot.kind}${limit > 1 ? 's' : ''} the AI uses as examples.`
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{slot.label}{slot.required && <span className="text-violet-300"> *</span>}</span>
        <Hint>{explain}{slot.help ? ` ${slot.help}` : ''}</Hint>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{items.length}/{limit}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((a) => (
          <div key={a.id} className="group relative w-24 overflow-hidden rounded-md border" title={a.name}>
            <MediaThumb kind={a.kind} url={a.url} className="aspect-video w-full" />
            <p className="truncate px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.name}</p>
            <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}
              className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100">
              <X className="size-2.5" />
            </button>
          </div>
        ))}
        {items.length < limit && (
          <button type="button" onClick={onPick}
            className="flex aspect-[24/17] w-24 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed text-[11px] text-muted-foreground transition hover:border-violet-400/50 hover:bg-violet-500/5 hover:text-foreground">
            <span className="flex items-center gap-0.5"><Plus className="size-3" /><Icon className="size-3" /></span>
            {items.length ? 'Add' : `Add ${slot.kind}`}
          </button>
        )}
      </div>
    </div>
  )
}

function ParamLabel({ name, label, help }: { name: string; label: string; help?: string }) {
  const text = help ?? PARAM_HELP[name]
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {text && <Hint>{text}</Hint>}
    </span>
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
    <div className="grid gap-3">
      {ints.map((p) => (
        <div key={p.name} className="grid gap-2">
          <div className="flex items-center justify-between">
            {model.mode === 'extend' && p.name === 'duration'
              ? <ParamLabel name={p.name} label="Seconds to add"
                  help="How many new seconds the AI adds after your clip ends. More seconds take longer and usually cost more credits." />
              : <ParamLabel name={p.name} label={p.label} />}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
              {model.mode === 'extend' && p.name === 'duration' && '+'}{String(params[p.name] ?? p.default)}{p.name === 'duration' && 's'}
            </span>
          </div>
          <Slider min={p.min ?? 0} max={p.max ?? 100} step={1} value={[Number(params[p.name] ?? p.default)]}
            onValueChange={([v]) => setParam(p.name, v)} aria-label={p.label} />
        </div>
      ))}
      {(enums.length > 0 || bools.length > 0) && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          {enums.map((p) => (
            <div key={p.name} className="grid gap-1.5">
              <ParamLabel name={p.name} label={p.label} />
              <Select value={String(params[p.name] ?? p.default)} onValueChange={(v) => setParam(p.name, v)}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {p.options?.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ))}
          {bools.map((p) => (
            <label key={p.name} htmlFor={p.name} className="flex h-full cursor-pointer items-center justify-between gap-2 self-end rounded-md border px-2.5 py-1.5">
              <ParamLabel name={p.name} label={p.label} />
              <Switch id={p.name} size="sm" checked={Boolean(params[p.name] ?? p.default)} onCheckedChange={(v) => setParam(p.name, v)} />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
