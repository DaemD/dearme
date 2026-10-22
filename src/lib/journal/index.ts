// Journal feature: live text, daily finalisation, one doodle per day, backup/restore.
// The UI talks to engine.ts exports, never this file directly.
import type { JournalEntry } from "@shared/types"
import { api, ApiRequestError } from "../api"
import { localDateStr } from "../memory/daylog"
import { getStorage } from "../storage"
import { downscale } from "./image"

// ---------------------------------------------------------------- state

let _clock: () => Date = () => new Date()
export function __setJournalClock(fn: (() => Date) | null): void {
  _clock = fn ?? (() => new Date())
}

// In-memory cache: date -> entry and image
const _entries = new Map<string, JournalEntry>()
const _images = new Map<string, string>()

// Which images have been backed up already this session (to avoid re-sending large data)
const _imageBackedUp = new Set<string>()

// Per-date lazy-image-fetch guard (one attempt per session per date)
const _imageFetched = new Set<string>()

const _listeners = new Set<() => void>()

/** Subscribe to journal data changes. Returns an unsubscribe function. */
export function subscribeJournal(fn: () => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

function notify(): void {
  for (const l of [..._listeners]) { try { l() } catch { /* ignore */ } }
}

// Separate mutex from the graph mutex
let _journalChain: Promise<unknown> = Promise.resolve()
function withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _journalChain.then(() => fn())
  _journalChain = run.catch(() => undefined)
  return run
}

// Running state for spinners
let _writing = false
let _drawingDate: string | null = null

export function journalStatus(): { writing: boolean; drawingDate: string | null } {
  return { writing: _writing, drawingDate: _drawingDate }
}

// Live refresh: track newest message id to skip unchanged, backoff on failure
let _liveRefreshRunning = false
let _liveBackoffUntil = 0
let _liveDebounceTimer: ReturnType<typeof setTimeout> | null = null
const LIVE_BACKOFF_MS = 5 * 60 * 1000
const LIVE_DEBOUNCE_MS = 25_000

// Per-date refresh guard (for "already running" check)
const _refreshRunning = new Set<string>()

// 503 guard: stop retrying for the session if backup storage not configured
let _syncDisabled = false

// Debounced backup per date
const _backupTimers = new Map<string, ReturnType<typeof setTimeout>>()
const BACKUP_DEBOUNCE_MS = 2_000

// ---------------------------------------------------------------- helpers

function todayDate(): string {
  return localDateStr(_clock())
}

/** True when it's past 04:00 local time on the day AFTER `date` (or older than yesterday). */
function isDayOver(date: string): boolean {
  const today = todayDate()
  if (date >= today) return false // today or future
  // yesterday: due if local hour >= 4 (i.e. UTC >= 23:00 the previous day)
  const now = _clock()
  const localHour = Math.floor((now.getTime() % (24 * 3600 * 1000)) / 3600000 + 5) % 24
  const yesterday = new Date(now.getTime() + 5 * 3600 * 1000)
  yesterday.setUTCHours(0, 0, 0, 0)
  const yesterdayDate = yesterday.toISOString().slice(0, 10)
  const twoDaysAgo = new Date(yesterday.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10)
  if (date <= twoDaysAgo) return true // older than yesterday: always due
  // yesterday: due only after 04:00 local
  if (date === yesterdayDate) return localHour >= 4
  return false
}

/** Messages for a given local date (from the global messages list injected by engine). */
let _getMessagesForDate: (date: string) => { id: string; role: "user" | "assistant"; content: string }[] = () => []

export function __setMessageGetter(fn: (date: string) => { id: string; role: "user" | "assistant"; content: string }[]): void {
  _getMessagesForDate = fn
}

async function persistEntry(entry: JournalEntry): Promise<void> {
  _entries.set(entry.localDate, entry)
  const store = await getStorage()
  await store.putJournal(entry)
}

async function persistImage(date: string, dataUrl: string): Promise<void> {
  _images.set(date, dataUrl)
  const store = await getStorage()
  await store.putJournalImage(date, dataUrl)
}

// ---------------------------------------------------------------- public reads

export function getJournalDates(todayChatted: boolean): string[] {
  const dates = new Set<string>()
  for (const d of _entries.keys()) dates.add(d)
  if (todayChatted) dates.add(todayDate())
  return [...dates].sort().reverse()
}

export function getJournalEntry(date: string): JournalEntry | null {
  return _entries.get(date) ?? null
}

export function getJournalImage(date: string): string | null {
  return _images.get(date) ?? null
}

// ---------------------------------------------------------------- backup

function scheduleJournalBackup(date: string, includeImage: boolean): void {
  const existing = _backupTimers.get(date)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    _backupTimers.delete(date)
    void doBackup(date, includeImage)
  }, BACKUP_DEBOUNCE_MS)
  _backupTimers.set(date, timer)
}

async function doBackup(date: string, includeImage: boolean): Promise<void> {
  if (_syncDisabled) return
  const entry = _entries.get(date)
  if (!entry) return
  const imageAlreadyBacked = _imageBackedUp.has(date)
  const imageData = (!imageAlreadyBacked && includeImage) ? (_images.get(date) ?? null) : null
  try {
    await api.journalPut({ entry, image: imageData })
    if (imageData) _imageBackedUp.add(date)
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 503) {
      _syncDisabled = true
      return
    }
    if (err instanceof ApiRequestError && err.status === 413 && imageData) {
      // retry without image
      try {
        await api.journalPut({ entry })
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------- init / restore

/** Called once on engine init. Loads cache from storage; if empty, restores from server. */
export async function initJournal(): Promise<void> {
  const store = await getStorage()
  // Recover stale "drawing" entries (older than 5 min) without counting an attempt
  const all = await store.listJournals()
  const now = _clock()
  for (const entry of all) {
    if (entry.imageStatus === "drawing") {
      const age = now.getTime() - new Date(entry.updatedAt).getTime()
      if (age > 5 * 60 * 1000) {
        const recovered = { ...entry, imageStatus: "failed" as const, updatedAt: now.toISOString() }
        await store.putJournal(recovered)
        _entries.set(entry.localDate, recovered)
      } else {
        _entries.set(entry.localDate, entry)
      }
    } else {
      _entries.set(entry.localDate, entry)
    }
  }
  // Load images from storage into memory cache
  for (const entry of _entries.values()) {
    if (entry.imageStatus === "ready") {
      const img = await store.getJournalImage(entry.localDate)
      if (img) _images.set(entry.localDate, img)
    }
  }
  // Restore from server if we have nothing locally
  if (_entries.size === 0) {
    void restoreFromServer()
  }
}

async function restoreFromServer(): Promise<void> {
  if (_syncDisabled) return
  try {
    const { dates } = await api.journalDates()
    const recent = dates.slice(0, 30)
    for (const date of recent) {
      const { entry, image } = await api.journalDay(date)
      if (entry) {
        const store = await getStorage()
        await store.putJournal(entry)
        _entries.set(date, entry)
        if (image && entry.imageStatus === "ready") {
          await store.putJournalImage(date, image)
          _images.set(date, image)
          _imageBackedUp.add(date)
        }
      }
    }
    notify()
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 503) _syncDisabled = true
  }
}

// ---------------------------------------------------------------- lazy image fetch

async function lazyFetchImage(date: string): Promise<void> {
  if (_imageFetched.has(date) || _images.has(date)) return
  _imageFetched.add(date)
  if (_syncDisabled) return
  try {
    const { image } = await api.journalDay(date)
    if (image) {
      await persistImage(date, image)
      _imageBackedUp.add(date)
      notify()
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- live refresh

export function scheduleDebounceRefresh(): void {
  if (_liveDebounceTimer) clearTimeout(_liveDebounceTimer)
  _liveDebounceTimer = setTimeout(() => {
    _liveDebounceTimer = null
    void refreshJournal(todayDate(), { force: false })
  }, LIVE_DEBOUNCE_MS)
}

export async function refreshJournal(date?: string, opts?: { force?: boolean }): Promise<void> {
  const target = date ?? todayDate()
  const force = opts?.force ?? false

  // Trigger finalisation on every refresh call
  void withJournalLock(() => finaliseDueJournals())

  const msgs = _getMessagesForDate(target)
  if (!msgs.some((m) => m.role === "user")) return // no user messages: nothing to write

  const entry = _entries.get(target)
  const newestId = [...msgs].reverse().find((m) => m.role === "user")?.id ?? null

  if (!force) {
    if (_refreshRunning.has(target)) return
    if (entry?.edited || entry?.finalised) return
    if (entry && entry.basedOnMessageId === newestId) return
    // Live: check backoff
    if (target === todayDate() && _clock().getTime() < _liveBackoffUntil) return
  }

  _refreshRunning.add(target)
  _writing = true
  notify()

  try {
    const isFinal = isDayOver(target)
    const response = await api.journal({
      localDate: target,
      final: isFinal,
      messages: msgs.slice(-80),
      previousParagraphs: entry?.paragraphs,
    })
    const now = _clock()
    const updated: JournalEntry = {
      localDate: target,
      title: response.title,
      paragraphs: response.paragraphs,
      mood: response.mood,
      scene: response.scene,
      caption: response.caption,
      basedOnMessageId: newestId,
      finalised: isFinal,
      edited: entry?.edited ?? false,
      imageStatus: entry?.imageStatus ?? "none",
      imageAttempts: entry?.imageAttempts ?? 0,
      updatedAt: now.toISOString(),
    }
    await persistEntry(updated)
    scheduleJournalBackup(target, false)
    notify()
  } catch {
    if (target === todayDate() && !_liveRefreshRunning) {
      _liveBackoffUntil = _clock().getTime() + LIVE_BACKOFF_MS
    }
  } finally {
    _refreshRunning.delete(target)
    _writing = false
    notify()
  }
}

// ---------------------------------------------------------------- finalisation

export async function finaliseDueJournals(): Promise<void> {
  // Find due dates (not finalised, has user messages, day is over), newest first, max 3
  const today = todayDate()
  const due: string[] = []
  for (const [date, entry] of _entries.entries()) {
    if (date >= today) continue
    if (entry.finalised && entry.imageStatus === "ready") continue
    if (isDayOver(date) && _getMessagesForDate(date).some((m) => m.role === "user")) {
      due.push(date)
    }
  }
  // Also check recent dates without any entry yet
  // (days with messages but no journal yet)
  // finalisation only acts on existing entries; the live refresh path handles new days

  due.sort().reverse()
  const batch = due.slice(0, 3)
  const now = _clock()

  for (const date of batch) {
    const entry = _entries.get(date)!
    // Step 1: finalise text (unless user edited)
    if (!entry.finalised) {
      const msgs = _getMessagesForDate(date)
      try {
        _writing = true
        notify()
        const response = await api.journal({
          localDate: date,
          final: true,
          messages: msgs.slice(-80),
          previousParagraphs: entry.edited ? undefined : entry.paragraphs,
        })
        const finalEntry: JournalEntry = {
          ...entry,
          ...(entry.edited ? {} : {
            title: response.title,
            paragraphs: response.paragraphs,
            mood: response.mood,
            scene: response.scene,
            caption: response.caption,
          }),
          finalised: true,
          updatedAt: now.toISOString(),
        }
        await persistEntry(finalEntry)
        scheduleJournalBackup(date, false)
        notify()
      } catch {
        // skip this date
        _writing = false
        notify()
        continue
      } finally {
        _writing = false
        notify()
      }
    }

    // Step 2: draw the image once (never again once ready)
    const current = _entries.get(date)!
    if (current.imageStatus === "ready") continue
    if (current.imageAttempts >= 3) continue

    _drawingDate = date
    const drawing: JournalEntry = { ...current, imageStatus: "drawing", updatedAt: now.toISOString() }
    await persistEntry(drawing)
    scheduleJournalBackup(date, false)
    notify()

    try {
      const { image: rawImage } = await api.journalImage({
        localDate: date,
        scene: current.scene,
        caption: current.caption,
        mood: current.mood,
      })
      const smallImage = await downscale(rawImage)
      await persistImage(date, smallImage)
      const done: JournalEntry = { ...drawing, imageStatus: "ready", updatedAt: _clock().toISOString() }
      await persistEntry(done)
      scheduleJournalBackup(date, true)
      notify()
    } catch (err) {
      const attempts = drawing.imageAttempts + 1
      const failed: JournalEntry = {
        ...drawing,
        imageStatus: "failed",
        imageAttempts: attempts,
        updatedAt: _clock().toISOString(),
      }
      await persistEntry(failed)
      scheduleJournalBackup(date, false)
      notify()
      // 429: stop this run
      if (err instanceof ApiRequestError && err.status === 429) break
    } finally {
      _drawingDate = null
      notify()
    }
  }
}

// ---------------------------------------------------------------- edit

export async function saveJournalEdit(date: string, paragraphs: string[], title?: string): Promise<void> {
  const trimmed = paragraphs.map((p) => p.trim()).filter(Boolean)
  if (trimmed.length < 1 || trimmed.length > 6) throw new Error("A journal page needs 1 to 6 paragraphs.")
  if (trimmed.some((p) => p.length > 600)) throw new Error("Each paragraph must be 600 characters or fewer.")
  const t = title !== undefined ? title.trim() : (_entries.get(date)?.title ?? "")
  if (t.length > 60) throw new Error("The title must be 60 characters or fewer.")
  const existing = _entries.get(date)
  if (!existing) throw new Error("No journal entry found for that date.")
  const updated: JournalEntry = {
    ...existing,
    paragraphs: trimmed,
    title: t || existing.title,
    edited: true,
    updatedAt: _clock().toISOString(),
  }
  await persistEntry(updated)
  scheduleJournalBackup(date, false)
  notify()
}

// ---------------------------------------------------------------- retry image

export async function retryJournalImage(date: string): Promise<void> {
  const entry = _entries.get(date)
  if (!entry) return
  if (!entry.finalised || entry.imageStatus === "ready" || entry.imageAttempts >= 3) return
  await withJournalLock(async () => {
    const current = _entries.get(date)!
    if (current.imageStatus === "ready" || current.imageAttempts >= 3) return
    const now = _clock()
    _drawingDate = date
    const drawing: JournalEntry = { ...current, imageStatus: "drawing", updatedAt: now.toISOString() }
    await persistEntry(drawing)
    notify()
    try {
      const { image: rawImage } = await api.journalImage({
        localDate: date,
        scene: current.scene,
        caption: current.caption,
        mood: current.mood,
      })
      const smallImage = await downscale(rawImage)
      await persistImage(date, smallImage)
      const done: JournalEntry = { ...drawing, imageStatus: "ready", updatedAt: _clock().toISOString() }
      await persistEntry(done)
      scheduleJournalBackup(date, true)
    } catch {
      const failed: JournalEntry = {
        ...drawing,
        imageStatus: "failed",
        imageAttempts: drawing.imageAttempts + 1,
        updatedAt: _clock().toISOString(),
      }
      await persistEntry(failed)
      scheduleJournalBackup(date, false)
    } finally {
      _drawingDate = null
      notify()
    }
  })
}

// ---------------------------------------------------------------- reset (tests)

export function __resetJournal(): void {
  _entries.clear()
  _images.clear()
  _imageBackedUp.clear()
  _imageFetched.clear()
  _refreshRunning.clear()
  _syncDisabled = false
  _writing = false
  _drawingDate = null
  _liveBackoffUntil = 0
  _liveRefreshRunning = false
  if (_liveDebounceTimer) { clearTimeout(_liveDebounceTimer); _liveDebounceTimer = null }
  for (const t of _backupTimers.values()) clearTimeout(t)
  _backupTimers.clear()
  _journalChain = Promise.resolve()
}

// expose for lazy image fetch from engine
export { lazyFetchImage }
