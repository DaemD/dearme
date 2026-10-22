// Test helpers: hand-made req/res objects, env snapshotting and a fake fetch (OpenAI + in-memory Redis).
import type { VercelRequest, VercelResponse } from "@vercel/node"
import { afterEach, beforeEach, vi } from "vitest"
import { signToken } from "../../api/_lib/auth"
import { resetMemory } from "../../api/_lib/ratelimit"

export const SECRET = "test-secret-key-0123456789"
export const PASSWORD = "correct horse battery staple"
export const ADMIN_KEY = "an-admin-key-that-is-long-enough"
export const REDIS_URL = "https://redis.test"

export interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  headersSent: boolean
  status(code: number): MockRes
  json(data: unknown): MockRes
  send(data: unknown): MockRes
  end(data?: unknown): MockRes
  setHeader(k: string, v: string): MockRes
  getHeader(k: string): string | undefined
}

export function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { res.statusCode = c; return res },
    json(d) { res.body = d; res.headersSent = true; return res },
    send(d) { res.body = d; res.headersSent = true; return res },
    end(d) { if (d !== undefined) res.body = d; res.headersSent = true; return res },
    setHeader(k, v) { res.headers[k.toLowerCase()] = String(v); return res },
    getHeader(k) { return res.headers[k.toLowerCase()] },
  }
  return res
}

export interface ReqInit {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
  ip?: string
  token?: string | null // adds an Authorization header; true-ish default handled by authed()
}

export function mockReq(init: ReqInit = {}): VercelRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
  if (init.token) headers.authorization = `Bearer ${init.token}`
  return {
    method: init.method ?? "GET", headers, body: init.body, query: init.query ?? {},
    socket: { remoteAddress: init.ip ?? "10.0.0.1" },
  } as unknown as VercelRequest
}

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void> | void

export async function call(handler: Handler, init: ReqInit = {}): Promise<MockRes> {
  const res = mockRes()
  await handler(mockReq(init), res as unknown as VercelResponse)
  return res
}

export const validToken = () => signToken()

/** Snapshot process.env around each test and give every test a clean, fully configured baseline. */
export function useEnv(baseline: Record<string, string | undefined> = {}) {
  let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }
    for (const k of [
      "ACCESS_PASSWORD", "SECRET_KEY", "ADMIN_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CHAT_MODEL",
      "MEMORY_MODEL_FAST", "MEMORY_MODEL_SLOW", "TRUST_PROXY_HEADERS", "SEED_OPS_JSON",
      "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
    ]) delete process.env[k]
    setEnv({ SECRET_KEY: SECRET, ACCESS_PASSWORD: PASSWORD, OPENAI_API_KEY: "sk-test-key", ...baseline })
    resetMemory()
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
}

export function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

export function enableRedis() {
  setEnv({ KV_REST_API_URL: REDIS_URL, KV_REST_API_TOKEN: "redis-token" })
}

export interface FakeFetch {
  calls: { url: string; init: RequestInit; json: any }[]
  openai: (body: any) => { status?: number; json?: unknown; throws?: boolean }
  redis: Map<string, string>
  redisDown: boolean
}

/** Stubs global fetch: URLs under REDIS_URL hit an in-memory Redis; everything else goes to `openai`. */
export function installFetch(openai?: FakeFetch["openai"]): FakeFetch {
  const fake: FakeFetch = {
    calls: [], redis: new Map(), redisDown: false,
    openai: openai ?? (() => ({ json: { choices: [{ message: { content: "ok" } }] } })),
  }
  const expiry = new Map<string, number>()
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const json = init.body ? JSON.parse(String(init.body)) : undefined
    fake.calls.push({ url: String(url), init, json })
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (String(url).startsWith(REDIS_URL)) {
      if (fake.redisDown) return reply(500, { error: "down" })
      const [cmd, key, arg] = json as string[]
      const r = fake.redis
      switch (cmd) {
        case "GET": return reply(200, { result: r.get(key) ?? null })
        case "SET": r.set(key, String(arg)); return reply(200, { result: "OK" })
        case "DEL": r.delete(key); return reply(200, { result: 1 })
        case "INCR": { const n = Number(r.get(key) ?? 0) + 1; r.set(key, String(n)); return reply(200, { result: n }) }
        case "EXPIRE": expiry.set(key, Number(arg)); return reply(200, { result: 1 })
        case "TTL": return reply(200, { result: r.has(key) ? (expiry.get(key) ?? -1) : -2 })
        default: return reply(400, { error: "unknown command" })
      }
    }
    const out = fake.openai(json)
    if (out.throws) throw new Error("network down")
    return reply(out.status ?? 200, out.json ?? {})
  })
  return fake
}

export const modelReply = (content: string) => ({ json: { choices: [{ message: { content } }] } })
