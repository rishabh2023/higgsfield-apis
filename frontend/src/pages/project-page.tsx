import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Film, Images, MoreHorizontal, Pencil, Search, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

import { PageHeader } from '@/components/app-shell'
import { isCreditError, TOP_UP_URL } from '@/lib/help'
import { Hint, Tip } from '@/components/hint'
import { CreatePanel } from '@/components/create-panel'
import { GenerationCard } from '@/components/generation-card'
import { Dropzone, MediaThumb } from '@/components/media'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, formatBytes, type Asset, type Generation, type Project } from '@/lib/api'

const POLL_MS = 3000
type Tab = 'create' | 'videos' | 'references'

export function ProjectPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const tab = (search.get('tab') as Tab) || 'create'
  const [project, setProject] = useState<Project | null>(null)
  const [gens, setGens] = useState<Generation[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const prevStatus = useRef<Record<string, string>>({})
  const load = useCallback(async () => {
    try {
      const list = await api.generations(projectId)
      // Tell the user when something they were waiting for finishes.
      for (const g of list) {
        const before = prevStatus.current[g.id]
        if (before && before !== g.status && ['submitting', 'queued', 'in_progress'].includes(before)) {
          const label = (g.prompt ?? 'Your video').slice(0, 60)
          if (g.status === 'completed') {
            toast.success('Video ready 🎬', { description: label })
            if (document.hidden) document.title = '✓ Video ready · Video Studio'
          } else if (['failed', 'nsfw'].includes(g.status)) {
            if (isCreditError(g.error)) {
              toast.error('Not enough Higgsfield credits', {
                description: 'Your balance is too low for this request. You were not charged.',
                action: { label: 'Top up', onClick: () => window.open(TOP_UP_URL, '_blank', 'noopener') },
                duration: 12000,
              })
            } else {
              toast.error('Video could not be made', { description: `${g.error ?? label}. You were not charged.` })
            }
          }
        }
      }
      prevStatus.current = Object.fromEntries(list.map((g) => [g.id, g.status]))
      setGens(list)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    const reset = () => { if (!document.hidden) document.title = 'Video Studio' }
    document.addEventListener('visibilitychange', reset)
    return () => document.removeEventListener('visibilitychange', reset)
  }, [])

  useEffect(() => {
    api.project(projectId).then(setProject).catch(() => navigate('/projects', { replace: true }))
    load()
  }, [projectId, load, navigate])

  // The backend polls Higgsfield and downloads outputs; the UI just re-reads while work is pending.
  const pending = gens?.some((g) => g.is_active || g.output?.status === 'downloading') ?? false
  useEffect(() => {
    if (!pending) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [pending, load])

  const upsert = (g: Generation) =>
    setGens((prev) => [g, ...(prev ?? []).filter((x) => x.id !== g.id)].sort((a, b) => b.created_at - a.created_at))
  const remove = (id: string) => setGens((prev) => (prev ?? []).filter((x) => x.id !== id))
  const setTab = (t: string) => setSearch((p) => {
    p.set('tab', t)
    return p
  })

  if (!project) return <div className="p-6"><Skeleton className="h-20" /></div>

  const active = gens?.filter((g) => g.is_active).length ?? 0

  return (
    <>
      <PageHeader
        back={
          <Link to="/projects" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3" /> Projects
          </Link>
        }
        title={project.name}
        description={project.description || undefined}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Project actions"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}><Pencil /> Rename</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}><Trash2 /> Delete project</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="mx-auto max-w-7xl gap-6 px-4 py-6 sm:px-6">
        <TabsList>
          <Tip label="Make a new video: from text, an image, references, or by editing/extending one you made">
            <TabsTrigger value="create"><Sparkles /> Create</TabsTrigger>
          </Tip>
          <Tip label="Every video in this project, with its status. Download, edit or extend from here.">
            <TabsTrigger value="videos">
              <Film /> Videos {gens && gens.length > 0 && <Badge variant="secondary" className="ml-1">{gens.length}</Badge>}
            </TabsTrigger>
          </Tip>
          <Tip label="Your saved images, clips and audio to guide new videos">
            <TabsTrigger value="references"><Images /> References</TabsTrigger>
          </Tip>
        </TabsList>

        <TabsContent value="create" className="grid gap-6 lg:grid-cols-[minmax(0,480px)_1fr]">
          <CreatePanel projectId={projectId} onCreated={upsert} />
          <section className="grid content-start gap-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold tracking-tight">Recent</h2>
              {gens && gens.length > 4 && (
                <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setTab('videos')}>
                  View all {gens.length} →
                </button>
              )}
            </div>
            <GenerationGrid gens={gens?.slice(0, 4) ?? null} onUpdate={upsert} onRemove={remove} single />
          </section>
        </TabsContent>

        <TabsContent value="videos" className="grid gap-4">
          <VideosTab gens={gens} active={active} onUpdate={upsert} onRemove={remove} />
        </TabsContent>

        <TabsContent value="references">
          <ReferencesPanel projectId={projectId} />
        </TabsContent>
      </Tabs>

      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} onSaved={setProject} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{project.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes its videos and reference files from this computer. Nothing is deleted on Higgsfield.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={async () => {
              try {
                await api.deleteProject(projectId)
                toast.success('Project deleted')
                navigate('/projects')
              } catch (err) {
                toast.error((err as Error).message)
              }
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const FILTERS: Record<string, { label: string; match: (s: string) => boolean }> = {
  all: { label: 'All statuses', match: () => true },
  completed: { label: 'Completed', match: (s) => s === 'completed' },
  running: { label: 'In progress', match: (s) => ['submitting', 'queued', 'in_progress'].includes(s) },
  problems: { label: 'Needs attention', match: (s) => !['completed', 'submitting', 'queued', 'in_progress'].includes(s) },
}

function VideosTab({ gens, active, onUpdate, onRemove }: {
  gens: Generation[] | null
  active: number
  onUpdate: (g: Generation) => void
  onRemove: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [mode, setMode] = useState('all')
  const shown = useMemo(() => gens?.filter((g) =>
    FILTERS[status].match(g.status)
    && (mode === 'all' || g.mode === mode)
    && (!q.trim() || (g.prompt ?? '').toLowerCase().includes(q.trim().toLowerCase())),
  ) ?? null, [gens, q, status, mode])

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(FILTERS).map(([k, f]) => <SelectItem key={k} value={k}>{f.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="text">Text to video</SelectItem>
            <SelectItem value="image">Image to video</SelectItem>
            <SelectItem value="reference">References</SelectItem>
            <SelectItem value="edit">Edits</SelectItem>
            <SelectItem value="extend">Extensions</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {active > 0 && <>{active} generating · updating every {POLL_MS / 1000}s · </>}
          {shown?.length ?? 0} of {gens?.length ?? 0}
        </span>
      </div>
      {gens && gens.length > 0 && shown?.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No videos match these filters.</p>
      ) : (
        <GenerationGrid gens={shown} onUpdate={onUpdate} onRemove={onRemove} />
      )}
    </>
  )
}

function GenerationGrid({ gens, onUpdate, onRemove, single = false }: {
  gens: Generation[] | null
  onUpdate: (g: Generation) => void
  onRemove: (id: string) => void
  single?: boolean
}) {
  const cols = single ? 'xl:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3'
  if (gens === null) {
    return <div className={`grid gap-4 ${cols}`}><Skeleton className="aspect-video" /><Skeleton className="aspect-video" /></div>
  }
  if (gens.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed py-20 text-center">
        <Film className="mb-3 size-8 text-muted-foreground" />
        <p className="font-medium">No videos yet</p>
        <p className="text-sm text-muted-foreground">Pick a mode, write a prompt and hit Generate.</p>
      </div>
    )
  }
  return (
    <div className={`grid items-start gap-4 ${cols}`}>
      {gens.map((g) => <GenerationCard key={g.id} g={g} onUpdate={onUpdate} onRemove={onRemove} />)}
    </div>
  )
}

function ReferencesPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const [assets, setAssets] = useState<Asset[] | null>(null)

  useEffect(() => {
    api.assets(projectId, 'library').then(setAssets).catch((e) => toast.error(e.message))
  }, [projectId])

  const use = (a: Asset, mode: string) =>
    navigate(`/projects/${projectId}?${new URLSearchParams({ tab: 'create', mode, [mode === 'reference' || mode === 'image' ? 'ref' : 'source']: a.id })}`)

  return (
    <div className="grid gap-6">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        Files here can be picked in the Create form as references, start images or videos to edit.
        <Hint>Uploads are checked and stored on this computer. They are only sent to Higgsfield when you generate with them.</Hint>
      </p>
      <Dropzone projectId={projectId} onUploaded={(a) => setAssets((p) => [a, ...(p ?? [])])} />
      {assets === null ? (
        <Skeleton className="h-40" />
      ) : assets.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">
          No references yet. Upload images, MP4 clips or WAV audio, or use “Add to references” on a generated video.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((a) => (
            <Card key={a.id} className="gap-0 overflow-hidden py-0">
              <MediaThumb kind={a.kind} url={a.url} controls={a.kind !== 'image'} className="aspect-video w-full" />
              <div className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={a.name}>{a.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.kind} · {a.source === 'generation' ? 'generated' : 'uploaded'}{a.size_bytes ? ` · ${formatBytes(a.size_bytes)}` : ''}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label="Reference actions"><MoreHorizontal /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => use(a, 'reference')}><Images /> Use as reference</DropdownMenuItem>
                    {a.kind === 'image' && <DropdownMenuItem onClick={() => use(a, 'image')}><Film /> Animate this image</DropdownMenuItem>}
                    {a.kind === 'video' && <DropdownMenuItem onClick={() => use(a, 'edit')}><Wand2 /> Edit this video</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={async () => {
                      try {
                        await api.deleteAsset(a.id)
                        setAssets((p) => (p ?? []).filter((x) => x.id !== a.id))
                      } catch (err) {
                        toast.error((err as Error).message)
                      }
                    }}>
                      <Trash2 /> {a.source === 'generation' ? 'Remove from references' : 'Delete file'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function EditProjectDialog({ project, open, onOpenChange, onSaved }: {
  project: Project
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: (p: Project) => void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  useEffect(() => {
    if (open) {
      setName(project.name)
      setDescription(project.description)
    }
  }, [open, project])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={async (e) => {
          e.preventDefault()
          try {
            onSaved(await api.updateProject(project.id, { name, description }))
            onOpenChange(false)
          } catch (err) {
            toast.error((err as Error).message)
          }
        }}>
          <DialogHeader><DialogTitle>Edit project</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="e-name">Name</Label>
            <Input id="e-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="e-desc">Description</Label>
            <Textarea id="e-desc" rows={3} className="resize-none" value={description} maxLength={1000}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
