import { useEffect, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type RawGeneration } from '@/lib/api'

export function JsonBlock({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(value, null, 2)
  return (
    <div className="relative">
      <Button size="icon-xs" variant="ghost" className="absolute top-2 right-2" aria-label="Copy"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}>
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre className="max-h-80 overflow-auto rounded-lg border bg-black/40 p-3 text-[11px] leading-relaxed text-muted-foreground">{text}</pre>
    </div>
  )
}

/** Exactly what was sent to Higgsfield, what came back, and every status change. */
export function RawDialog({ generationId, open, onOpenChange }: {
  generationId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [raw, setRaw] = useState<RawGeneration | null>(null)
  useEffect(() => {
    if (!open) return
    setRaw(null)
    api.raw(generationId).then(setRaw).catch((e) => toast.error(e.message))
  }, [open, generationId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raw data</DialogTitle>
          <DialogDescription>
            The exact request sent to Higgsfield, its raw answer, and every status change. Useful for support. Share the
            request ID with Higgsfield if something went wrong.
          </DialogDescription>
        </DialogHeader>
        {!raw ? (
          <div className="grid place-items-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Request ID</dt><dd className="font-mono break-all">{raw.higgsfield_request_id ?? '—'}</dd>
              <dt className="text-muted-foreground">Correlation ID</dt><dd className="font-mono break-all">{raw.correlation_id ?? '—'}</dd>
              <dt className="text-muted-foreground">Model</dt><dd className="font-mono">{raw.model}</dd>
              <dt className="text-muted-foreground">Status</dt><dd>{raw.status}</dd>
            </dl>
            <Tabs defaultValue="request">
              <TabsList>
                <TabsTrigger value="request">Sent</TabsTrigger>
                <TabsTrigger value="response">Received</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="record">Record</TabsTrigger>
              </TabsList>
              <TabsContent value="request"><JsonBlock value={raw.request_sent_to_higgsfield} /></TabsContent>
              <TabsContent value="response">
                {raw.higgsfield_response ? <JsonBlock value={raw.higgsfield_response} /> : (
                  <p className="py-6 text-center text-sm text-muted-foreground">No final answer yet.</p>
                )}
              </TabsContent>
              <TabsContent value="history">
                <ol className="grid gap-1.5 text-xs">
                  {raw.status_history.map((h, i) => (
                    <li key={i} className="flex gap-3 rounded-md border px-3 py-1.5">
                      <span className="font-mono text-muted-foreground">{h.ts.replace('T', ' ').replace('Z', ' UTC')}</span>
                      <span className="font-medium">{h.op === 'delete' ? 'deleted' : h.status}</span>
                      {h.error && <span className="truncate text-muted-foreground">{h.error}</span>}
                    </li>
                  ))}
                </ol>
              </TabsContent>
              <TabsContent value="record"><JsonBlock value={raw.record} /></TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
