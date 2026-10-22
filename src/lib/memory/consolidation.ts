// Nightly consolidation: read one local day of conversation and edit the knowledge graph.
import { COVERAGE_SLOTS, HUB_ID } from "@shared/types"
import type {
  ChatMsg, ConsolidateRequest, ConsolidateResponse, CoverageSlot, DayLog, Graph,
} from "@shared/types"
import { applyDiff, cleanText, coreProfile, normText, search } from "./graph"
import type { Rejected } from "./graph"
import { dayLogCoverage, dayLogNotes, localDateStr, localHour, newDayLog } from "./daylog"

export const MAX_MESSAGES = 80
export const MAX_MESSAGE_CHARS = 600
export const MAX_LLM_OPS = 40
export const MAX_NODES_IN_REQUEST = 150
export const MAX_FACTS_IN_REQUEST = 40
export const DUE_HOUR = 4
const DAY_MS = 24 * 3600 * 1000

/** The local day messages belong to. */
export function messagesOnLocalDate(messages: ChatMsg[], localDate: string): ChatMsg[] {
  return messages.filter((m) => localDateStr(new Date(m.createdAt)) === localDate)
}

/** Yesterday's local date if it still needs consolidating (local time >= 04:00), else null. */
export function consolidationDue(messages: ChatMsg[], dayLogs: DayLog[], now: Date): string | null {
  if (localHour(now) < DUE_HOUR) return null
  const yesterday = localDateStr(new Date(now.getTime() - DAY_MS))
  const log = dayLogs.find((l) => l.localDate === yesterday)
  if (log && log.consolidatedAt) return null
  const has = messagesOnLocalDate(messages, yesterday).some((m) => m.role === "user")
  return has ? yesterday : null
}

export function buildConsolidateRequest(args: {
  graph: Graph
  messages: ChatMsg[]
  dayLog?: DayLog | null
  localDate: string
}): ConsolidateRequest {
  const { graph, localDate } = args
  const dayMsgs = messagesOnLocalDate(args.messages, localDate).slice(-MAX_MESSAGES)
  const nodes = Object.values(graph.nodes)
    .filter((n) => n.status === "active" && n.type !== "day")
    .slice(0, MAX_NODES_IN_REQUEST)
    .map((n) => ({ id: n.id, name: n.name, type: n.type, aliases: [...n.aliases] }))
  const userText = dayMsgs
    .filter((m) => m.role === "user")
    .map((m) => m.content.slice(0, MAX_MESSAGE_CHARS))
    .join(" ")
    .slice(0, 1500)
  const facts = coreProfile(graph, 20, true)
  const seen = new Set(facts.map((f) => f.id))
  for (const f of search(graph, userText, 25, true)) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      facts.push(f)
    }
  }
  return {
    localDate,
    messages: dayMsgs.map((m) => ({ id: m.id, role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) })),
    notes: dayLogNotes(args.dayLog).map((n) => n.text),
    coverage: dayLogCoverage(args.dayLog),
    nodes,
    facts: facts.slice(0, MAX_FACTS_IN_REQUEST).map((f) => ({ id: f.id, text: f.text })),
  }
}

export interface ConsolidationResult {
  graph: Graph
  dayLog: DayLog
  changed: boolean
  applied: number
  rejected: Rejected[]
}

function restrictEvidence(op: unknown, known: Set<string>): unknown {
  if (!op || typeof op !== "object" || Array.isArray(op)) return op
  const copy: Record<string, unknown> = { ...(op as Record<string, unknown>) }
  for (const key of ["evidence", "evidence_add"]) {
    const value = copy[key]
    if (Array.isArray(value)) copy[key] = value.filter((i) => typeof i === "string" && known.has(i))
  }
  return copy
}

/**
 * Apply the model's response. A malformed or failed response changes nothing (changed: false and the
 * same graph and day log objects come back). The day node, its HAD_DAY fact, the graph ops and the day
 * log update all land in one result so the caller can persist them together.
 */
export function applyConsolidation(
  graph: Graph,
  dayLog: DayLog | null | undefined,
  response: unknown,
  opts: { localDate: string; messages: ChatMsg[]; now: Date },
): ConsolidationResult {
  const { localDate, now } = opts
  const log = dayLog ?? newDayLog(localDate)
  const unchanged: ConsolidationResult = { graph, dayLog: log, changed: false, applied: 0, rejected: [] }
  if (!response || typeof response !== "object") return unchanged
  const res = response as Partial<ConsolidateResponse>
  const summary = cleanText(res.summary, 1000)
  if (!summary || !Array.isArray(res.ops)) return unchanged

  const dayMsgs = messagesOnLocalDate(opts.messages, localDate).slice(-MAX_MESSAGES)
  const known = new Set(dayMsgs.map((m) => m.id))
  const rejected: Rejected[] = []
  res.ops.slice(MAX_LLM_OPS).forEach((op, i) => {
    const name = op && typeof op === "object" && typeof (op as { op?: unknown }).op === "string" ? (op as { op: string }).op : null
    rejected.push({ op: name, index: MAX_LLM_OPS + i, error: `too many ops from the model (max ${MAX_LLM_OPS})` })
  })
  const modelOps = res.ops.slice(0, MAX_LLM_OPS).map((op) => restrictEvidence(op, known))
  const modelCount = modelOps.length

  const dayText = summary.slice(0, 300)
  const tail: unknown[] = [{ op: "add_node", type: "day", name: localDate }]
  for (const edge of Object.values(graph.edges)) {
    const target = graph.nodes[edge.target]
    if (
      edge.type === "HAD_DAY" && edge.status === "active" && target && target.name === localDate &&
      normText(edge.text) !== normText(dayText)
    ) {
      tail.push({ op: "outdate_fact", id: edge.id, reason: "day re-consolidated" })
    }
  }
  tail.push({
    op: "add_fact", source: HUB_ID, target: { name: localDate, type: "day" }, type: "HAD_DAY",
    text: dayText, source_kind: "inferred", confidence: 0.7, evidence: [...known].sort().slice(0, 20),
  })

  const result = applyDiff(graph, { ops: [...modelOps, ...tail] }, { reason: `consolidate:${localDate}`, now })
  for (const r of result.rejected) if (r.index < modelCount) rejected.push(r)
  const bookkeepingRejected = result.rejected.filter((r) => r.index >= modelCount).length
  const applied = Math.max(0, result.applied - (tail.length - bookkeepingRejected))

  const coverage = dayLogCoverage(log)
  if (res.coverage && typeof res.coverage === "object" && !Array.isArray(res.coverage)) {
    for (const slot of COVERAGE_SLOTS) {
      const text = cleanText((res.coverage as Record<string, unknown>)[slot], 200)
      if (text && !(slot in coverage)) (coverage as Record<CoverageSlot, string>)[slot] = text
    }
  }
  const nextLog: DayLog = { ...log, coverage, summary, consolidatedAt: now.toISOString() }
  return { graph: result.graph, dayLog: nextLog, changed: true, applied, rejected }
}
