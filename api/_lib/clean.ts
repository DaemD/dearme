// Light server-side shaping of model output. The browser does the strict sanitising.
import type { CoverageSlot } from "../../shared/types"

// Same list as COVERAGE_SLOTS in shared/types.ts (kept local so functions need no runtime import from shared/).
export const COVERAGE_SLOTS: readonly CoverageSlot[] = [
  "mood", "activities", "food", "study", "people", "sleep", "highlight", "plans",
]

export function cleanNotes(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((n): n is string => typeof n === "string" && n.trim() !== "" && n.length <= 200).slice(0, 3)
}

export function cleanCoverage(v: unknown): Partial<Record<CoverageSlot, string>> {
  const out: Partial<Record<CoverageSlot, string>> = {}
  if (!v || typeof v !== "object" || Array.isArray(v)) return out
  for (const slot of COVERAGE_SLOTS) {
    const t = (v as Record<string, unknown>)[slot]
    if (typeof t === "string" && t.trim() !== "" && t.length <= 200) out[slot] = t
  }
  return out
}

/** Keeps plain-object ops only (at most `max`); null when ops is not an array. */
export function cleanOps(v: unknown, max: number): unknown[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((o) => o && typeof o === "object" && !Array.isArray(o)).slice(0, max)
}
