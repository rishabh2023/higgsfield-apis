// All calls go to the same-origin /api (proxied by Vite). The Higgsfield key is sent to
// our backend once when saved and is never returned or stored in the browser.

export type CredentialStatus = {
  configured: boolean
  key_hint: string | null
  verified: boolean
  usable: boolean
  warning?: string | null
}

export type ModeId = 'text' | 'image' | 'reference' | 'edit' | 'extend'
export type MediaKind = 'image' | 'video' | 'audio'

export type Mode = { id: ModeId; name: string; description: string }

export type ParamSpec = {
  name: string
  label: string
  type: 'int' | 'enum' | 'bool'
  default: number | string | boolean
  min: number | null
  max: number | null
  options: string[] | null
  help: string | null
}

export type MediaSlot = {
  name: string
  label: string
  kind: MediaKind
  multiple: boolean
  required: boolean
  max: number
  help: string | null
}

export type ModelSpec = {
  id: string
  name: string
  mode: ModeId
  docs: string
  prompt_required: boolean
  prompt_max: number
  params: ParamSpec[]
  media: MediaSlot[]
  require_one_of: string[]
  notes: string[]
}

export type Catalog = { modes: Mode[]; models: ModelSpec[] }

export type Project = {
  id: string
  name: string
  description: string
  created_at: number
  updated_at: number
  generations: number
  active: number
  references: number
  cover_url: string | null
}

export type Asset = {
  id: string
  project_id: string
  kind: MediaKind
  source: 'upload' | 'generation'
  generation_id: string | null
  name: string
  content_type: string
  size_bytes: number | null
  in_library: boolean
  status: 'ready' | 'downloading' | 'download_failed'
  error: string | null
  created_at: number
  url: string
}

export type AssetBrief = { id: string; name: string; kind: MediaKind | null; url: string | null }

export type Generation = {
  id: string
  project_id: string
  model: string
  mode: ModeId
  prompt: string | null
  params: Record<string, unknown>
  media: Record<string, AssetBrief[]>
  status: string
  request_id: string | null
  remote_video_url: string | null
  output: Asset | null
  error: string | null
  correlation_id: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
  is_active: boolean
  can_cancel: boolean
}

export type CreateGenerationBody = {
  model: string
  prompt: string | null
  params: Record<string, unknown>
  media: Record<string, string[]>
  allow_duplicate?: boolean
}

export type Stats = {
  projects: number
  generations: number
  by_status: Record<string, number>
  completed_by_model: Record<string, number>
  saved_files: number
  saved_bytes: number
  data_dir: string
  ledger: { file: string; bytes: number }
  last_backup: string | null
}

export type StoredFile = Asset & {
  project_name: string
  model: string | null
  on_disk: boolean
  path: string | null
  used_as_input: boolean
  remote_url: string | null
}

export type StorageList = { files: StoredFile[]; total_bytes: number; counts: { outputs: number; uploads: number } }

export type LedgerEntry = {
  ts: string
  op: 'upsert' | 'delete'
  table: string
  key: string
  status?: string
  row: Record<string, unknown> | null
}

export type RawGeneration = {
  generation_id: string
  higgsfield_request_id: string | null
  correlation_id: string | null
  model: string
  status: string
  request_sent_to_higgsfield: Record<string, unknown>
  higgsfield_response: Record<string, unknown> | null
  status_history: { ts: string; op: string; status: string | null; error: string | null }[]
  record: Record<string, unknown>
}

/** Must match API_VERSION in backend/app/main.py. */
export const EXPECTED_API_VERSION = 4

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      'X-Requested-With': 'video-gen',
      ...(init.headers ?? {}),
    },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = body?.detail
    const msg = Array.isArray(detail)
      ? detail.map((d: { loc?: string[]; msg: string }) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg}`).join('; ')
      : typeof detail === 'string'
        ? detail
        : typeof detail?.message === 'string'
          ? detail.message
          : `Request failed (${res.status})`
    throw new ApiError(res.status, msg, detail)
  }
  return body as T
}

const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) })

export const api = {
  catalog: () => request<Catalog>('/models'),

  getKey: () => request<CredentialStatus>('/settings/api-key'),
  saveKey: (key_id: string, key_secret: string) => request<CredentialStatus>('/settings/api-key', json('PUT', { key_id, key_secret })),
  deleteKey: () => request<void>('/settings/api-key', { method: 'DELETE' }),

  projects: () => request<Project[]>('/projects'),
  project: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (name: string, description: string) => request<Project>('/projects', json('POST', { name, description })),
  updateProject: (id: string, patch: { name?: string; description?: string }) =>
    request<Project>(`/projects/${id}`, json('PATCH', patch)),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  assets: (projectId: string, scope: 'library' | 'all' = 'all') => request<Asset[]>(`/projects/${projectId}/assets?scope=${scope}`),
  upload: (projectId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<Asset>(`/projects/${projectId}/assets`, { method: 'POST', body: fd })
  },
  updateAsset: (id: string, patch: { name?: string; in_library?: boolean }) => request<Asset>(`/assets/${id}`, json('PATCH', patch)),
  deleteAsset: (id: string) => request<void>(`/assets/${id}`, { method: 'DELETE' }),
  retryDownload: (id: string) => request<Asset>(`/assets/${id}/retry-download`, { method: 'POST' }),

  stats: () => request<Stats>('/stats'),
  version: () => request<{ api_version: number }>('/version'),
  storage: () => request<StorageList>('/storage'),
  deleteFiles: (asset_ids: string[]) => request<{ deleted: number }>('/storage/delete', json('POST', { asset_ids })),
  clearStorage: (scope: 'failed' | 'unused_uploads' | 'everything') =>
    request<Record<string, number>>('/storage/clear', json('POST', { scope })),
  raw: (generationId: string) => request<RawGeneration>(`/generations/${generationId}/raw`),
  ledger: (limit = 200) =>
    request<{ file: string; bytes: number; total_lines: number; entries: LedgerEntry[] }>(`/ledger?limit=${limit}`),
  compactLedger: () => request<{ bytes_before: number; bytes_after: number }>('/ledger/compact', { method: 'POST' }),
  generation: (id: string) => request<Generation>(`/generations/${id}`),
  generations: (projectId: string) => request<Generation[]>(`/projects/${projectId}/generations`),
  generate: (projectId: string, body: CreateGenerationBody, idempotencyKey: string) =>
    request<Generation>(`/projects/${projectId}/generations`, { ...json('POST', body), headers: { 'Idempotency-Key': idempotencyKey } }),
  cancel: (id: string) => request<Generation>(`/generations/${id}/cancel`, { method: 'POST' }),
  refresh: (id: string) => request<Generation>(`/generations/${id}/refresh`, { method: 'POST' }),
  removeGeneration: (id: string) => request<void>(`/generations/${id}`, { method: 'DELETE' }),
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export function formatBytes(n: number | null): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
