// All calls go to the same-origin /api (proxied by Vite). The Higgsfield key is sent to
// our backend once when saved and is never returned or stored in the browser.

export type CredentialStatus = {
  configured: boolean
  key_hint: string | null
  verified: boolean
  usable: boolean
  warning?: string | null
}

export type VideoInput = {
  prompt: string
  duration: number
  resolution: '480p' | '720p' | '1080p' | '4k'
  aspect_ratio: '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9'
  generate_audio: boolean
}

export type Generation = {
  id: string
  model: string
  input: VideoInput
  status: string
  request_id: string | null
  video_url: string | null
  error: string | null
  correlation_id: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
  is_active: boolean
  can_cancel: boolean
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
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
        : `Request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return body as T
}

export const api = {
  getKey: () => request<CredentialStatus>('/settings/api-key'),
  saveKey: (key_id: string, key_secret: string) =>
    request<CredentialStatus>('/settings/api-key', { method: 'PUT', body: JSON.stringify({ key_id, key_secret }) }),
  deleteKey: () => request<void>('/settings/api-key', { method: 'DELETE' }),
  list: () => request<Generation[]>('/generations'),
  create: (input: VideoInput, idempotencyKey: string) =>
    request<Generation>('/generations', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ model: 'bytedance/seedance-2.0/text-to-video', input }),
    }),
  cancel: (id: string) => request<Generation>(`/generations/${id}/cancel`, { method: 'POST' }),
  refresh: (id: string) => request<Generation>(`/generations/${id}/refresh`, { method: 'POST' }),
  remove: (id: string) => request<void>(`/generations/${id}`, { method: 'DELETE' }),
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
