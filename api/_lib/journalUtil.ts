// Small helpers shared by the journal endpoints: date check, text cleaning, daily call caps.
import * as store from "./store.js"

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** YYYY-MM-DD that is a real calendar date. */
export function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** Control characters (newlines and tabs included) become spaces; whitespace is collapsed and trimmed. */
export function oneLine(s: string): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim()
}

/** Cut to at most max characters, preferring a sentence or word boundary. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim()
}

// ---- daily caps (per UTC day): Redis counter when configured, in-memory otherwise or on Redis trouble ----
const memory = new Map<string, number>()

/** Test helper. */
export const resetDailyCaps = () => memory.clear()

/** Counts one use; returns true when it is still within `max` for today (UTC). */
export async function takeDaily(name: string, max: number, now: Date = new Date()): Promise<boolean> {
  const day = now.toISOString().slice(0, 10)
  const key = `zeneb:cap:${name}:${day}`
  if (store.isConfigured()) {
    try {
      return (await store.incrWithExpire(key, 2 * 24 * 60 * 60)) <= max
    } catch {
      // fall through to the in-memory counter
    }
  }
  for (const k of memory.keys()) if (!k.endsWith(day)) memory.delete(k)
  const n = (memory.get(key) ?? 0) + 1
  memory.set(key, n)
  return n <= max
}
