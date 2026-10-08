export type ApiErrorContext = {
  provider: string
  model: string
  baseUrl: string
  role: "primary" | "fallback"
}

export type ClassifiedApiError = ApiErrorContext & {
  code: string
  status: number | null
  terminal: boolean
  fingerprint: string
  summary: string
  guidance: string | null
}
