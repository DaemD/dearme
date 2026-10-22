// Failure counters for login (and admin-key guesses). Same semantics as owner_auth.py: 5 failures per
// client and 30 overall within a 15 minute window, then locked out (even for the right secret).
// Counters live in Redis when configured (shared across function instances) and always in module memory
// too, which is the fallback when Redis is missing or erroring.
// The window is fixed from the first failure (the Python version slides); close enough for a lockout.
import * as store from "./store.js"

export const MAX_PER_CLIENT = 5
export const MAX_OVERALL = 30
export const WINDOW_SECONDS = 15 * 60

const memory = new Map<string, { count: number; resetAt: number }>()

/** Test helper: forget in-memory counters. */
export const resetMemory = () => memory.clear()

const clientKey = (scope: string, client: string) => `zeneb:fail:${scope}:c:${client}`
const overallKey = (scope: string) => `zeneb:fail:${scope}:all`

function memCount(key: string): number {
  const e = memory.get(key)
  return !e || e.resetAt <= Date.now() ? 0 : e.count
}
const memWait = (key: string) => Math.max(0, Math.ceil(((memory.get(key)?.resetAt ?? 0) - Date.now()) / 1000))
function memIncr(key: string) {
  const e = memory.get(key)
  if (!e || e.resetAt <= Date.now()) memory.set(key, { count: 1, resetAt: Date.now() + WINDOW_SECONDS * 1000 })
  else e.count++
}

/** Seconds until this client may try again, or 0 if it may try now. */
export async function retryAfter(scope: string, client: string): Promise<number> {
  const buckets: [string, number][] = [
    [clientKey(scope, client), MAX_PER_CLIENT],
    [overallKey(scope), MAX_OVERALL],
  ]
  const waits: number[] = []
  for (const [key, max] of buckets) {
    let count = memCount(key)
    let wait = memWait(key)
    if (store.isConfigured()) {
      try {
        count = await store.getInt(key)
        if (count >= max) wait = await store.ttl(key, WINDOW_SECONDS)
      } catch {
        // storage trouble: keep the in-memory numbers read above
      }
    }
    if (count >= max) waits.push(wait || 1)
  }
  return waits.length ? Math.max(...waits) : 0
}

export async function recordFailure(scope: string, client: string): Promise<void> {
  for (const key of [clientKey(scope, client), overallKey(scope)]) {
    memIncr(key)
    if (!store.isConfigured()) continue
    try {
      await store.incrWithExpire(key, WINDOW_SECONDS)
    } catch {
      // the memory counter above still counts
    }
  }
}

/** A success clears that client's counter only (the overall one keeps counting). */
export async function recordSuccess(scope: string, client: string): Promise<void> {
  const key = clientKey(scope, client)
  memory.delete(key)
  if (!store.isConfigured()) return
  try {
    await store.del(key)
  } catch {
    // ignore
  }
}
