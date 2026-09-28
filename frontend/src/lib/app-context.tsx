import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { api, type Catalog, type CredentialStatus } from '@/lib/api'

type AppState = {
  catalog: Catalog | null
  credential: CredentialStatus | null
  setCredential: (c: CredentialStatus) => void
  reloadCredential: () => Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [credential, setCredential] = useState<CredentialStatus | null>(null)

  const reloadCredential = useCallback(async () => {
    setCredential(await api.getKey())
  }, [])

  useEffect(() => {
    // Credentials first: this request also establishes the workspace cookie.
    reloadCredential()
      .catch(() => setCredential({ configured: false, key_hint: null, verified: false, usable: false }))
      .finally(() => api.catalog().then(setCatalog).catch(() => undefined))
  }, [reloadCredential])

  return <Ctx.Provider value={{ catalog, credential, setCredential, reloadCredential }}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside AppProvider')
  return v
}

export function canGenerate(c: CredentialStatus | null): boolean {
  return !!c?.configured && c.usable
}
