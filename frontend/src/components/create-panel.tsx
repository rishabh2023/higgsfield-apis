import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FastForward, Film, ImageIcon, Images, Info, Loader2, Mic, Plus, Sparkles, Square, Type, Wand2, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'

import { AssetPicker, KIND_ICON, MediaThumb } from '@/components/media'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Hint, Tip } from '@/components/hint'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiError, api, newIdempotencyKey, type Asset, type AssetBrief, type Generation, type MediaSlot, type ModeId,
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

  function addChip(text: string) {
    setPrompt((p) => (p.trim() ? `${p.trim().replace(/[.,]$/, '')}, ${text}` : text.charAt(0).toUpperCase() + text.slice(1)))
  }

  return (
    <form onSubmit={submit} className="grid gap-4"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          send(false)
        }
      }}>
      {/* Mode picker */}
      <div className="grid grid-cols-5 gap-1.5 rounded-xl border bg-muted/20 p-1.5">
        {catalog.modes.map((m) => {
          const { label, icon: Icon } = MODE_TAB[m.id]
          const active = m.id === mode
          return (
            <Tip key={m.id} side="bottom" label={<><b>{m.name}</b>: {MODE_HELP[m.id].how}</>}>
              <button type="button" onClick={() => selectMode(m.id)} aria-pressed={active}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-xs font-medium transition',
                  active ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}>
                <Icon className={cn('size-4', active && 'text-violet-300')} />
                {label}
              </button>
            </Tip>
          )
        })}
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {/* How it works */}
        <div className="border-b bg-gradient-to-br from-violet-500/10 via-transparent to-sky-500/5 px-5 py-4">
          <p className="text-base font-semibold">{catalog.modes.find((m) => m.id === mode)?.name}
            <span className="ml-2 text-sm font-normal text-muted-foreground">{modeHelp.tagline}</span>
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{modeHelp.how}</p>
          {mode === 'extend' && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium">
              <span className="rounded-md border bg-background/60 px-2 py-1">Your clip</span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded-md border border-violet-400/40 bg-violet-500/10 px-2 py-1 text-violet-200">
                + {durationParam ?? 5}s new footage
              </span>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground/80"><span className="text-muted-foreground">Best for:</span> {modeHelp.bestFor}</p>
        </div>

        <CardContent className="grid gap-6 px-5 py-5">
          <Step n={1} title="Model" hint="Different AI models give different looks, lengths and prices. You can switch any time; your prompt and files are kept.">
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
              <Tip label="Open this model’s official documentation">
                <Button asChild variant="ghost" size="icon" aria-label="Model documentation">
                  <a href={model.docs} target="_blank" rel="noreferrer"><ExternalLink /></a>
                </Button>
              </Tip>
            </div>
            {model.notes.map((n) => (
              <p key={n} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" /> {n}
              </p>
            ))}
          </Step>

          {model.media.length > 0 && (
            <Step n={2} title={mode === 'edit' || mode === 'extend' ? 'Your video' : mode === 'image' ? 'Your images' : 'References'}
              hint="Pick files from this project (uploads or videos you made) or upload new ones. Accepted: JPG/PNG/WEBP/GIF images, MP4 video, WAV audio.">
              <div className="grid gap-4">
                {model.media.map((slot) => (
                  <SlotField key={slot.name} slot={slot} items={media[slot.name] ?? []}
                    onPick={() => setPicking(slot)}
                    onRemove={(id) => setMedia((p) => ({ ...p, [slot.name]: (p[slot.name] ?? []).filter((a) => a.id !== id) }))} />
                ))}
                {needsOneOf && (
                  <p className="text-xs text-amber-300/90">
                    Add at least one: {model.require_one_of.map((n) => model.media.find((s) => s.name === n)?.label.toLowerCase()).join(' or ')}.
                  </p>
                )}
              </div>
            </Step>
          )}

          <Step n={model.media.length ? 3 : 2}
            title={<>Prompt {!model.prompt_required && <span className="font-normal text-muted-foreground">(optional)</span>}</>}
            hint={PROMPT_HELP}
            aside={<span className={`text-xs tabular-nums ${promptTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{prompt.length}/{model.prompt_max}</span>}>
            <div className="relative">
              <Textarea id="prompt" rows={4} className={cn('resize-none pb-11', speech.listening && 'border-red-400/60')}
                placeholder={PLACEHOLDER[mode]} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              <div className="absolute right-2 bottom-2 left-2 flex items-center justify-end gap-1.5">
                {speech.listening && (
                  <span className="mr-auto flex items-center gap-1.5 text-xs text-red-300">
                    <span className="size-2 animate-pulse rounded-full bg-red-400" /> Listening… speak your prompt
                  </span>
                )}
                {prompt && !speech.listening && (
                  <Tip label="Clear the prompt">
                    <Button type="button" size="icon-xs" variant="ghost" className="mr-auto text-muted-foreground" onClick={() => setPrompt('')} aria-label="Clear prompt"><X /></Button>
                  </Tip>
                )}
                {speech.supported && (
                  <>
                    <Tip label="Language you’ll speak in">
                      <span>
                        <Select value={lang} onValueChange={(v) => {
                          setLang(v)
                          try { localStorage.setItem('vs:speech-lang', v) } catch { /* ignore */ }
                        }}>
                          <SelectTrigger size="sm" className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none" aria-label="Dictation language">
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
                      <Button type="button" size="sm" variant={speech.listening ? 'destructive' : 'secondary'}
                        onClick={() => (speech.listening ? speech.stop() : speech.start(prompt, lang))}>
                        {speech.listening ? <><Square className="fill-current" /> Stop</> : <><Mic /> Speak</>}
                      </Button>
                    </Tip>
                  </>
                )}
              </div>
            </div>
            <div className="grid gap-1.5">
              {PROMPT_CHIPS.map((g) => (
                <div key={g.group} className="flex flex-wrap items-center gap-1">
                  <span className="w-14 text-[11px] text-muted-foreground">{g.group}</span>
                  {g.items.map((t) => (
                    <button key={t} type="button" onClick={() => addChip(t)}
                      className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-violet-400/50 hover:bg-violet-500/10 hover:text-foreground">
                      + {t}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground/80">Example: {modeHelp.example}</p>
          </Step>

          {model.params.length > 0 && (
            <Step n={model.media.length ? 4 : 3} title="Settings" hint="Length, quality and shape of the video. Hover the (i) next to each for details.">
              <ParamFields model={model} params={params} setParam={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
            </Step>
          )}
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-2 border-t bg-muted/10 px-5 py-4">
          <p className="truncate text-center text-xs text-muted-foreground">{summary}</p>
          <Tip label={ready ? 'Send to Higgsfield. Shortcut: ⌘/Ctrl + Enter. Uses credits from your Higgsfield account.' : 'Add your API key in Settings first'}>
            <span className="grid">
              <Button type="submit" size="lg" disabled={!ready || submitting || !valid}>
                {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {submitting ? (model.media.length ? 'Preparing files & submitting…' : 'Submitting…') : 'Generate'}
                {!submitting && <kbd className="ml-1 hidden rounded border border-current/30 px-1 text-[10px] opacity-60 sm:inline">⌘↵</kbd>}
              </Button>
            </span>
          </Tip>
          {!ready && (
            <p className="text-center text-xs text-muted-foreground">
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

function Step({ n, title, hint, aside, children }: {
  n: number
  title: React.ReactNode
  hint: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-2.5">
      <div className="flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-full bg-violet-500/15 text-[11px] font-semibold text-violet-200">{n}</span>
        <h3 className="text-sm font-medium">{title}</h3>
        <Hint>{hint}</Hint>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </section>
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
    <div className="grid gap-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">
          {slot.label} {slot.required && <span className="text-violet-300">*</span>}
        </Label>
        <Hint>{explain}{slot.help ? ` ${slot.help}` : ''}</Hint>
        <span className="ml-auto text-xs text-muted-foreground">{items.length}/{limit}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <div key={a.id} className="group relative w-28 overflow-hidden rounded-lg border" title={a.name}>
            <MediaThumb kind={a.kind} url={a.url} className="aspect-video w-full" />
            <p className="truncate px-1.5 py-1 text-[11px]">{a.name}</p>
            <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100">
              <X className="size-3" />
            </button>
          </div>
        ))}
        {items.length < limit && (
          <button type="button" onClick={onPick}
            className="flex aspect-[28/22] w-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground transition hover:border-violet-400/50 hover:bg-violet-500/5 hover:text-foreground">
            <span className="flex items-center gap-1"><Plus className="size-3.5" /><Icon className="size-3.5" /></span>
            {items.length ? 'Add more' : `Choose ${slot.kind}`}
          </button>
        )}
      </div>
    </div>
  )
}

function ParamLabel({ name, label, htmlFor, help }: { name: string; label: string; htmlFor?: string; help?: string }) {
  const text = help ?? PARAM_HELP[name]
  return (
    <span className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs">{label}</Label>
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
    <div className="grid gap-4">
      {ints.map((p) => (
        <div key={p.name} className="grid gap-3">
          <div className="flex items-baseline justify-between">
            {model.mode === 'extend' && p.name === 'duration'
              ? <ParamLabel name={p.name} label="Seconds to add"
                  help="How many new seconds the AI adds after your clip ends. More seconds take longer and usually cost more credits." />
              : <ParamLabel name={p.name} label={p.label} />}
            <span className="font-mono text-sm tabular-nums">{String(params[p.name] ?? p.default)}{p.name === 'duration' && 's'}</span>
          </div>
          <Slider min={p.min ?? 0} max={p.max ?? 100} step={1} value={[Number(params[p.name] ?? p.default)]}
            onValueChange={([v]) => setParam(p.name, v)} />
          <div className="-mt-1 flex justify-between text-[10px] text-muted-foreground/70"><span>{p.min}s</span><span>{p.max}s</span></div>
        </div>
      ))}
      {enums.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {enums.map((p) => (
            <div key={p.name} className="grid gap-2">
              <ParamLabel name={p.name} label={p.label} />
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
            <ParamLabel name={p.name} label={p.label} htmlFor={p.name} />
            {p.help && <span className="text-xs text-muted-foreground">{p.help}</span>}
          </div>
          <Switch id={p.name} checked={Boolean(params[p.name] ?? p.default)} onCheckedChange={(v) => setParam(p.name, v)} />
        </div>
      ))}
    </div>
  )
}
