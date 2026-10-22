// Typed fetch wrappers for the Vercel functions (contract: shared/types.ts). Login is not here.
import type {
  ChatRequest, ChatResponse, ConsolidateRequest, ConsolidateResponse, ExtractRequest, ExtractResponse,
  SeedResponse, SyncGetResponse, SyncState,
} from "@shared/types"
import { getToken, handleUnauthorized } from "./session"

export const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again."
export const UNAUTHORIZED_MESSAGE = "Your session has expired. Please sign in again."

/** An error from the API. status is 0 for network failures. */
export class ApiRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
  }
}

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiRequestError(0, NETWORK_ERROR_MESSAGE)
  }

  if (res.status === 401) {
    handleUnauthorized()
    throw new ApiRequestError(401, UNAUTHORIZED_MESSAGE)
  }

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }

  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" && typeof (payload as { detail?: unknown }).detail === "string"
        ? ((payload as { detail: string }).detail)
        : ""
    throw new ApiRequestError(res.status, detail || `Something went wrong (error ${res.status}). Please try again.`)
  }
  return payload as T
}

export const api = {
  chat: (body: ChatRequest) => request<ChatResponse>("POST", "/api/chat", body),
  extract: (body: ExtractRequest) => request<ExtractResponse>("POST", "/api/extract", body),
  consolidate: (body: ConsolidateRequest) => request<ConsolidateResponse>("POST", "/api/consolidate", body),
  seed: () => request<SeedResponse>("GET", "/api/seed"),
  getSync: () => request<SyncGetResponse>("GET", "/api/sync"),
  putSync: (state: SyncState) => request<{ savedAt: string }>("PUT", "/api/sync", state),
}
