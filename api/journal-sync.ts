import { JOURNAL_MOODS, type JournalEntry } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { isObj, isRealDate } from "./_lib/journalUtil.js"
import * as store from "./_lib/store.js"

export const INDEX_KEY = "zeneb:journal:index"
export const entryKey = (date: string) => `zeneb:journal:${date}`
export const imageKey = (date: string) => `zeneb:journalimg:${date}`
const MAX_DATES = 800
const MAX_IMAGE_CHARS = 250_000

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000

/** Strict shape check against JournalEntry; keeps only the known fields. */
export function toEntry(v: unknown): JournalEntry | null {
  if (!isObj(v) || !isRealDate(v.localDate) || !str(v.title, 60)) return null
  const p = v.paragraphs
  if (!Array.isArray(p) || p.length < 1 || p.length > 6 || !p.every((x) => str(x, 600))) return null
  if (v.mood !== null && !(typeof v.mood === "string" && (JOURNAL_MOODS as readonly string[]).includes(v.mood))) return null
  if (!str(v.scene, 240) || !str(v.caption, 80)) return null
  if (v.basedOnMessageId !== null && !str(v.basedOnMessageId, 64)) return null
  if (typeof v.finalised !== "boolean" || typeof v.edited !== "boolean") return null
  if (v.imageStatus !== "none" && v.imageStatus !== "drawing" && v.imageStatus !== "ready" && v.imageStatus !== "failed") return null
  if (!count(v.imageAttempts) || !str(v.updatedAt, 40) || v.updatedAt === "") return null
  return {
    localDate: v.localDate, title: v.title, paragraphs: p as string[], mood: v.mood as JournalEntry["mood"],
    scene: v.scene, caption: v.caption, basedOnMessageId: v.basedOnMessageId as string | null,
    finalised: v.finalised, edited: v.edited, imageStatus: v.imageStatus, imageAttempts: v.imageAttempts,
    updatedAt: v.updatedAt,
  }
}

/** The stored date index (descending). Throws when storage fails. */
export async function readIndex(): Promise<string[]> {
  const raw = await store.get(INDEX_KEY)
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter(isRealDate) : []
  } catch {
    return []
  }
}

export default route(["GET", "PUT"], async (req, res) => {
  if (!requireAuth(req, res)) return

  if (req.method === "PUT") {
    const body = bodyOf(req)
    if (!isObj(body)) return fail(res, 400, "Invalid backup")
    const entry = toEntry(body.entry)
    if (!entry) return fail(res, 400, "Invalid backup")
    const image = body.image
    if (image !== undefined && image !== null) {
      if (typeof image !== "string" || !image.startsWith("data:image/")) return fail(res, 400, "Invalid backup")
      if (image.length > MAX_IMAGE_CHARS) return fail(res, 413, "Image is too large")
    }
    if (!store.isConfigured()) return fail(res, 503, "Backup storage is not set up")
    try {
      await store.set(entryKey(entry.localDate), JSON.stringify(entry))
      if (typeof image === "string") await store.set(imageKey(entry.localDate), image)
      const dates = Array.from(new Set([entry.localDate, ...(await readIndex())])).sort().reverse().slice(0, MAX_DATES)
      await store.set(INDEX_KEY, JSON.stringify(dates))
    } catch {
      return fail(res, 502, "Backup storage is unavailable right now.")
    }
    return void res.status(200).json({ savedAt: new Date().toISOString() })
  }

  if (!store.isConfigured()) return fail(res, 503, "Backup storage is not set up")
  const date = req.query?.date
  if (date !== undefined && !isRealDate(Array.isArray(date) ? date[0] : date)) return fail(res, 400, "Invalid date")
  try {
    if (date === undefined) return void res.status(200).json({ dates: await readIndex() })
    const d = String(Array.isArray(date) ? date[0] : date)
    const [rawEntry, image] = await Promise.all([store.get(entryKey(d)), store.get(imageKey(d))])
    let entry: JournalEntry | null = null
    if (rawEntry) {
      try {
        entry = JSON.parse(rawEntry) as JournalEntry
      } catch {
        entry = null
      }
    }
    res.status(200).json({ entry, image: image ?? null })
  } catch {
    fail(res, 502, "Backup storage is unavailable right now.")
  }
})
