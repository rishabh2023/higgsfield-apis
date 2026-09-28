import { useState } from 'react'
import { KeyRound, Loader2, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type CredentialStatus } from '@/lib/api'

type Props = {
  status: CredentialStatus | null
  onChange: (s: CredentialStatus) => void
}

export function ApiKeyCard({ status, onChange }: Props) {
  const [editing, setEditing] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const showForm = editing || !status?.configured

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.saveKey(keyId.trim(), secret.trim())
      onChange(res)
      setKeyId('')
      setSecret('')
      setEditing(false)
      if (res.warning) toast.warning(res.warning)
      else toast.success('API key verified and saved')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteKey()
      onChange({ configured: false, key_hint: null, verified: false, usable: false })
      toast.success('API key removed')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" /> Higgsfield API key
        </CardTitle>
        <CardDescription>
          Stored encrypted on the server and reused for every generation. It is never sent back to the browser.
        </CardDescription>
        {status?.configured && !editing && (
          <CardAction>
            {status.verified && status.usable ? (
              <Badge variant="secondary" className="text-emerald-400">
                <ShieldCheck /> Verified
              </Badge>
            ) : (
              <Badge variant="destructive">
                <ShieldAlert /> {status.usable ? 'Unverified' : 'Unreadable'}
              </Badge>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {showForm ? (
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="key-id">API key ID</Label>
              <Input
                id="key-id"
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. 3f2c…"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-secret">API key secret</Label>
              <Input
                id="key-secret"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder="••••••••••••"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Create one in the{' '}
              <a className="underline underline-offset-4 hover:text-foreground" href="https://console.higgsfield.ai" target="_blank" rel="noreferrer">
                Higgsfield Console
              </a>
              . We check it with a free status lookup before saving.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !keyId.trim() || !secret.trim()}>
                {busy && <Loader2 className="animate-spin" />} Verify &amp; save
              </Button>
              {status?.configured && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
            <div className="font-mono text-sm">
              <span className="text-muted-foreground">Key ID </span>
              {status?.key_hint}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                Replace
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={remove} disabled={busy} aria-label="Remove API key">
                <Trash2 />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
