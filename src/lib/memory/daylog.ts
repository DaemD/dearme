// "Today" notes and coverage. Local time is a fixed UTC+5 (Lahore); no Intl or timezone database.
import { COVERAGE_SLOTS } from "@shared/types"
import type { CoverageSlot, DayLog } from "@shared/types"
import { cleanText } from "./graph"

export const LOCAL_OFFSET_HOURS = 5
export const MAX_NOTES_PER_DAY = 40
export const MAX_NOTE_CHARS = 200

const OFFSET_MS = LOCAL_OFFSET_HOURS * 3600 * 1000

function shifted(now: Date): string {
  return new Date(now.getTime() + OFFSET_MS).toISOString()
}

/** YYYY-MM-DD in local (UTC+5) time. */
export function localDateStr(now: Date): string {
  return shifted(now).slice(0, 10)
}

/** HH:MM in local (UTC+5) time. */
export function localTimeHHMM(now: Date): string {
  return shifted(now).slice(11, 16)
}

/** Local hour 0-23. */
export function localHour(now: Date): number {
  return Number(shifted(now).slice(11, 13))
}

export function isCoverageSlot(value: unknown): value is CoverageSlot {
  return typeof value === "string" && (COVERAGE_SLOTS as readonly string[]).includes(value)
}

export function newDayLog(localDate: string): DayLog {
  return { localDate, notes: [], coverage: {}, summary: null, consolidatedAt: null }
}

export function dayLogNotes(log: DayLog | null | undefined): { t: string; text: string }[] {
  if (!log || !Array.isArray(log.notes)) return []
  return log.notes.filter((n) => n && typeof n.text === "string")
}

export function dayLogCoverage(log: DayLog | null | undefined): Partial<Record<CoverageSlot, string>> {
  const out: Partial<Record<CoverageSlot, string>> = {}
  const cov = log && log.coverage && typeof log.coverage === "object" ? log.coverage : {}
  for (const [slot, value] of Object.entries(cov)) {
    if (isCoverageSlot(slot) && typeof value === "string" && value) out[slot] = value
  }
  return out
}

/** Upsert notes and coverage into a day log (returns a new object). Never throws. */
export function addDayNotes(
  log: DayLog | null | undefined,
  notes: unknown,
  coverage: unknown,
  now: Date,
): DayLog {
  const base: DayLog = log ?? newDayLog(localDateStr(now))
  try {
    const stored = dayLogNotes(base).map((n) => ({ ...n }))
    const known = new Set(stored.map((n) => n.text))
    const hhmm = localTimeHHMM(now)
    const incoming = typeof notes === "string" ? [notes] : Array.isArray(notes) ? notes : []
    for (const raw of incoming) {
      const text = cleanText(raw, MAX_NOTE_CHARS)
      if (!text || known.has(text)) continue
      if (stored.length >= MAX_NOTES_PER_DAY) break
      stored.push({ t: hhmm, text })
      known.add(text)
    }
    const merged = dayLogCoverage(base)
    if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
      for (const [slot, value] of Object.entries(coverage as Record<string, unknown>)) {
        const text = cleanText(value, MAX_NOTE_CHARS)
        if (isCoverageSlot(slot) && text) merged[slot] = text
      }
    }
    return { ...base, notes: stored, coverage: merged }
  } catch {
    return base
  }
}

export function coverageGaps(log: DayLog | null | undefined): CoverageSlot[] {
  const covered = dayLogCoverage(log)
  return COVERAGE_SLOTS.filter((slot) => !(slot in covered))
}
