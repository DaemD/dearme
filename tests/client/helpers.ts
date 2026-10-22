import { vi } from "vitest"

export interface RecordedCall {
  method: string
  path: string
  body: any
  headers: Record<string, string>
}
export interface RouteReply {
  status?: number
  body?: unknown
  /** make fetch itself reject, like a dropped connection */
  networkError?: boolean
}
export type Route = (call: RecordedCall) => RouteReply | Promise<RouteReply>

/** Stubs global fetch with a router keyed "METHOD /api/path". Unknown routes answer 404. */
export function installFetch(routes: Record<string, Route>) {
  const calls: RecordedCall[] = []
  const stub = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    const call: RecordedCall = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: init?.headers ?? {},
    }
    calls.push(call)
    const route = routes[`${method} ${path}`]
    if (!route) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })
    const reply = await route(call)
    if (reply.networkError) throw new TypeError("fetch failed")
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", stub)
  return {
    calls,
    count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length,
    of: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  }
}

export function silenceConsole() {
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "info").mockImplementation(() => undefined)
}
