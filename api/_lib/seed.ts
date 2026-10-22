// The starting ops come from configuration, never from code: env SEED_OPS_JSON (a JSON string of Op[]) or,
// when that is unset, the gitignored file api/_data/seed.json (or the path in SEED_FILE). Anything invalid or missing gives an empty list.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Op } from "../../shared/types"

const MAX_SEED_OPS = 200

function parseOps(raw: string): Op[] {
  try {
    const v = JSON.parse(raw) as unknown
    const ok =
      Array.isArray(v) &&
      v.length <= MAX_SEED_OPS &&
      v.every((o) => o && typeof o === "object" && !Array.isArray(o) && typeof (o as { op?: unknown }).op === "string")
    return ok ? (v as Op[]) : []
  } catch {
    return [] // nothing is logged: the content may be personal
  }
}

export function seedOps(): Op[] {
  const fromEnv = process.env.SEED_OPS_JSON
  if (fromEnv) return parseOps(fromEnv)
  try {
    // SEED_FILE overrides the default path (tests use it so they never touch the real file)
    const file = process.env.SEED_FILE || join(process.cwd(), "api", "_data", "seed.json")
    return existsSync(file) ? parseOps(readFileSync(file, "utf8")) : []
  } catch {
    return []
  }
}
