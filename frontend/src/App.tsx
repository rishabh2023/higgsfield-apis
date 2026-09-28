import { useCallback, useEffect, useState } from 'react'
import { Film } from 'lucide-react'

import { ApiKeyCard } from '@/components/api-key-card'
import { GenerateForm } from '@/components/generate-form'
import { GenerationCard } from '@/components/generation-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, type CredentialStatus, type Generation } from '@/lib/api'

const POLL_MS = 3000

export default function App() {
  const [cred, setCred] = useState<CredentialStatus | null>(null)
  const [items, setItems] = useState<Generation[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await api.list())
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    // Credentials first: this request also establishes the workspace cookie.
    api.getKey().then(setCred).catch((e) => setLoadError(e.message)).finally(load)
  }, [load])

  // The backend polls Higgsfield; the UI just re-reads our own DB while jobs are active.
  const hasActive = items?.some((g) => g.is_active) ?? false
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [hasActive, load])

  const upsert = (g: Generation) =>
    setItems((prev) => [g, ...(prev ?? []).filter((x) => x.id !== g.id)].sort((a, b) => b.created_at - a.created_at))

  const canGenerate = !!cred?.configured && cred.usable

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-background">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-2.5 px-4 sm:px-6">
            <div className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-sky-500">
              <Film className="size-4 text-white" />
            </div>
            <span className="font-semibold tracking-tight">Video Studio</span>
            <span className="text-sm text-muted-foreground">· Higgsfield</span>
          </div>
        </header>

        <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[400px_1fr]">
          <aside className="grid content-start gap-6 lg:sticky lg:top-20 lg:self-start">
            {cred === null ? <Skeleton className="h-44" /> : <ApiKeyCard status={cred} onChange={setCred} />}
            <GenerateForm disabled={!canGenerate} onCreated={upsert} />
          </aside>

          <section className="grid content-start gap-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight">Your generations</h2>
              {hasActive && <span className="text-xs text-muted-foreground">Updating every {POLL_MS / 1000}s</span>}
            </div>
            {loadError && <p className="text-sm text-destructive">{loadError}</p>}
            {items === null ? (
              <div className="grid gap-4 md:grid-cols-2">
                <Skeleton className="aspect-video" />
                <Skeleton className="aspect-video" />
              </div>
            ) : items.length === 0 ? (
              <div className="grid place-items-center rounded-xl border border-dashed py-24 text-center">
                <Film className="mb-3 size-8 text-muted-foreground" />
                <p className="font-medium">No videos yet</p>
                <p className="text-sm text-muted-foreground">Describe a shot on the left and hit Generate.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {items.map((g) => (
                  <GenerationCard
                    key={g.id}
                    g={g}
                    onUpdate={upsert}
                    onRemove={(id) => setItems((p) => (p ?? []).filter((x) => x.id !== id))}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
        <Toaster position="bottom-right" richColors />
      </div>
    </TooltipProvider>
  )
}
