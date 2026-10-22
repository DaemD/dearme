// Code-side enforcement for the live extractor: the model's ops are never trusted as they come.
import type { Op } from "@shared/types"
import { MAX_TEXT } from "./graph"

export const MAX_LIVE_OPS = 6
export const LIVE_INFERRED_MAX_CONFIDENCE = 0.6
export const MAX_VALID_UNTIL_DAYS = 30
const ALLOWED = new Set(["add_node", "add_fact", "update_fact", "outdate_fact"])

type Raw = Record<string, unknown>

function clampValidUntil(op: Raw, today: string): void {
  if (!("valid_until" in op)) return
  const value = op.valid_until
  let parsed: Date | null = null
  if (typeof value === "string") {
    const head = value.trim().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) {
      const d = new Date(`${head}T00:00:00Z`)
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === head) parsed = d
    }
  }
  if (!parsed) {
    delete op.valid_until
    return
  }
  const limit = new Date(`${today}T00:00:00Z`)
  limit.setUTCDate(limit.getUTCDate() + MAX_VALID_UNTIL_DAYS)
  op.valid_until = (parsed < limit ? parsed : limit).toISOString().slice(0, 10)
}

/**
 * @param today local date, YYYY-MM-DD
 * @param userMessageId id used as evidence when the model supplied none
 */
export function sanitiseLiveOps(ops: unknown, today: string, userMessageId: string | null): Op[] {
  if (!Array.isArray(ops)) return []
  const kept: Raw[] = []
  for (const raw of ops) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const name = (raw as Raw).op
    if (typeof name !== "string" || !ALLOWED.has(name)) continue
    const op: Raw = { ...(raw as Raw) }
    delete op.sensitivity // decided by the graph (sensitive nodes) or the nightly pass, never by the live model
    if (name === "add_fact") {
      const text = op.text
      if (typeof text !== "string" || !text.trim() || text.trim().length > MAX_TEXT) continue
      if (op.source_kind === "inferred") {
        const conf = op.confidence
        if (typeof conf === "number" && Number.isFinite(conf)) {
          op.confidence = Math.min(conf, LIVE_INFERRED_MAX_CONFIDENCE)
        }
      }
      const evidence = op.evidence
      if ((!Array.isArray(evidence) || evidence.length === 0) && userMessageId !== null) {
        op.evidence = [userMessageId]
      }
    }
    if (name === "update_fact" && typeof op.text === "string" && op.text.trim().length > MAX_TEXT) continue
    if (name === "add_fact" || name === "update_fact") clampValidUntil(op, today)
    kept.push(op)
  }
  return kept.slice(0, MAX_LIVE_OPS) as unknown as Op[]
}
