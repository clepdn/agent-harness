export interface EditResult {
  ok: boolean
  message: string
}

export interface RunRawOptions {
  timeoutMs?: number
  pty?: boolean
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export interface ImageToolPayload {
  ok?: boolean
  message?: string
  path?: string
  mime?: string
  bytes?: number
  data_url?: string
}
