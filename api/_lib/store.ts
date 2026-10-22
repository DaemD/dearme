// Upstash Redis over its REST API with plain fetch (no SDK). Used for the backup copy and the lockout counters.
import type { Graph } from "../../shared/types"

export const STATE_KEY = "zeneb:state"

function config(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}

export const isConfigured = (): boolean => config() !== null

/** Run one Redis command, e.g. ["GET", "key"]. Throws on any failure (the message never contains the token). */
export async function command(args: (string | number)[]): Promise<unknown> {
  const cfg = config()
  if (!cfg) throw new Error("storage not configured")
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`storage error ${res.status}`)
    const data = (await res.json()) as { result?: unknown; error?: string }
    if (data.error) throw new Error("storage command failed")
    return data.result ?? null
  } finally {
    clearTimeout(timer)
  }
}

export async function get(key: string): Promise<string | null> {
  const r = await command(["GET", key])
  return typeof r === "string" ? r : null
}

export async function set(key: string, value: string): Promise<void> {
  await command(["SET", key, value])
}

export async function del(key: string): Promise<void> {
  await command(["DEL", key])
}

/** Increment a counter; the first increment starts a fixed expiry window. Returns the new count. */
export async function incrWithExpire(key: string, seconds: number): Promise<number> {
  const n = Number(await command(["INCR", key]))
  if (n === 1) await command(["EXPIRE", key, seconds])
  return n
}

/** Seconds left on a key's expiry. A key without an expiry (should not happen) is given a fresh one. */
export async function ttl(key: string, seconds: number): Promise<number> {
  const t = Number(await command(["TTL", key]))
  if (t < 0) {
    await command(["EXPIRE", key, seconds])
    return seconds
  }
  return t
}

export async function getInt(key: string): Promise<number> {
  return Number((await get(key)) ?? 0) || 0
}

/** The empty graph: just the hub node (same shape the Python backend starts from). */
export function emptyGraph(now: Date = new Date()): Graph {
  const stamp = now.toISOString()
  return {
    version: 1,
    updated_at: stamp,
    nodes: {
      zeneb: {
        id: "zeneb", type: "person", name: "Zeneb", aliases: [], summary: "",
        sensitivity: "normal", status: "active", first_seen: stamp, last_seen: stamp,
      },
    },
    edges: {},
  }
}
