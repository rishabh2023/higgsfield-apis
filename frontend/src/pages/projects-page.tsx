import { useEffect, useState } from 'react'
import { Film, FolderPlus, Images, KeyRound, Loader2, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'

import { PageHeader } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, timeAgo, type Project } from '@/lib/api'
import { canGenerate, useApp } from '@/lib/app-context'

export function ProjectsPage() {
  const { credential } = useApp()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => toast.error(e.message))
  }, [])

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project keeps its own videos and reference files together."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New project
          </Button>
        }
      />
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6">
        {credential && !canGenerate(credential) && (
          <Link
            to="/settings"
            className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm transition-colors hover:bg-amber-500/10"
          >
            <KeyRound className="size-4 text-amber-300" />
            <span>
              <span className="font-medium text-amber-200">Add your Higgsfield API key</span>
              <span className="text-muted-foreground"> in Settings to start generating videos.</span>
            </span>
          </Link>
        )}

        {projects === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[4/3] rounded-xl" />)}
          </div>
        ) : projects.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed py-24 text-center">
            <FolderPlus className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">Create your first project</p>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">
              A project holds the videos you generate and the reference images, clips and audio you use to guide them.
            </p>
            <Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
          </div>
        )}
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function ProjectCard({ p }: { p: Project }) {
  return (
    <Link to={`/projects/${p.id}`} className="group">
      <Card className="gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/20">
        <div className="relative aspect-video bg-muted/40">
          {p.cover_url ? (
            <video src={p.cover_url} muted playsInline preload="metadata" className="size-full object-cover"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => undefined)}
              onMouseLeave={(e) => e.currentTarget.pause()} />
          ) : (
            <div className="grid size-full place-items-center">
              <Film className="size-8 text-muted-foreground/50" />
            </div>
          )}
          {p.active > 0 && (
            <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-violet-200">
              <Loader2 className="size-3 animate-spin" /> {p.active} generating
            </span>
          )}
        </div>
        <div className="grid gap-1 p-4">
          <p className="truncate font-medium">{p.name}</p>
          {p.description && <p className="line-clamp-1 text-sm text-muted-foreground">{p.description}</p>}
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Film className="size-3.5" /> {p.generations}</span>
            <span className="flex items-center gap-1"><Images className="size-3.5" /> {p.references}</span>
            <span className="ml-auto">{timeAgo(p.updated_at)}</span>
          </div>
        </div>
      </Card>
    </Link>
  )
}

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const p = await api.createProject(name, description)
      onOpenChange(false)
      setName('')
      setDescription('')
      navigate(`/projects/${p.id}`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Group related videos and their reference files.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="p-name">Name</Label>
            <Input id="p-name" autoFocus placeholder="e.g. Summer campaign" value={name} maxLength={120}
              onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="p-desc" rows={3} className="resize-none" value={description} maxLength={1000}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" />} Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
