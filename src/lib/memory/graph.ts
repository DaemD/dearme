// The knowledge graph: pure functions over the Graph type (copy-on-write), ported from the
// Python store without embeddings. Nothing in here ever hard-deletes a node or a fact.
import { HUB_ID } from "@shared/types"
import type { Graph, GraphEdge, GraphNode } from "@shared/types"

export const MAX_OPS = 80
export const MAX_TEXT = 300
export const MAX_NAME = 80
export const INFERRED_MAX_CONFIDENCE = 0.7
export const DEDUPE_CONFIDENCE_BUMP = 0.05
export const SEARCH_THRESHOLD = 0.05
export const DIARY_EDGE_TYPES = new Set(["HAD_DAY"])

const NODE_TYPES = new Set([
  "person", "pet", "place", "organisation", "course", "activity", "food", "event",
  "goal", "topic", "trait", "habit", "preference", "day",
])
const SENSITIVITIES = new Set(["normal", "sensitive"])
const SOURCE_KINDS = new Set(["said", "inferred"])

const STOPWORDS = new Set(
  `a about after all also am an and any are as at be been being but by can could did do does doing for from
  had has have having he her hers him his how i if in into is it its just me my of on or our she so some than
  that the their them then there these they this those to too up us very was we were what when where which who
  why will with would you your yours not no yes get got really`.split(/\s+/),
)

export interface Rejected {
  op: string | null
  index: number
  error: string
}
export interface ApplyResult {
  graph: Graph
  applied: number
  rejected: Rejected[]
  reason: string
}
export interface FactView {
  id: string
  text: string
  type: string
  source_kind: "said" | "inferred"
  confidence: number
  last_seen: string
  sensitivity: "normal" | "sensitive"
  nodes: string[]
}

type AnyOp = Record<string, unknown>

class OpError extends Error {}

// ---------------------------------------------------------------- helpers

export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  const flat = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
  return flat.slice(0, limit).trim()
}

export function normText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").replace(/\s+/g, " ").trim()
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  const flat = (text || "").toLowerCase().replace(/'s/g, "").replace(/'/g, "")
  for (let tok of flat.match(/[a-z0-9]+/g) ?? []) {
    if (tok.length < 2 || STOPWORDS.has(tok)) continue
    if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) tok = tok.slice(0, -1)
    out.add(tok)
  }
  return out
}

function randomHex8(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function newId(prefix: string, existing: Record<string, unknown>): string {
  for (;;) {
    const candidate = `${prefix}_${randomHex8()}`
    if (!(candidate in existing)) return candidate
  }
}

export function emptyGraph(now: Date = new Date()): Graph {
  const stamp = iso(now)
  return {
    version: 1,
    updated_at: stamp,
    nodes: {
      [HUB_ID]: {
        id: HUB_ID, type: "person", name: "Zeneb", aliases: [], summary: "",
        sensitivity: "normal", status: "active", first_seen: stamp, last_seen: stamp,
      },
    },
    edges: {},
  }
}

export function exportGraph(graph: Graph): Graph {
  return graph
}

export function isGraph(value: unknown): value is Graph {
  if (!value || typeof value !== "object") return false
  const g = value as Record<string, unknown>
  return (
    typeof g.nodes === "object" && g.nodes !== null && !Array.isArray(g.nodes) &&
    typeof g.edges === "object" && g.edges !== null && !Array.isArray(g.edges)
  )
}

export function hasEdges(graph: Graph): boolean {
  return Object.keys(graph.edges).length > 0
}

function parseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string") throw new OpError("date must be an ISO string")
  const head = value.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) throw new OpError(`invalid date: ${JSON.stringify(value)}`)
  const d = new Date(`${head}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== head) {
    throw new OpError(`invalid date: ${JSON.stringify(value)}`)
  }
  return head
}

function parseConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OpError("confidence must be a number")
  return Math.max(0, Math.min(1, value))
}

function parseEvidence(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new OpError("evidence must be a list of message ids")
  return value.filter((v): v is string => typeof v === "string" && v.length > 0)
}

function mergeEvidence(current: string[], extra: string[]): string[] {
  const merged = [...current]
  for (const v of extra) if (!merged.includes(v)) merged.push(v)
  return merged
}

function parseEdgeType(value: unknown): string {
  if (typeof value !== "string") throw new OpError("type is required")
  const cleaned = cleanText(value, 60).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (!cleaned) throw new OpError("type is required")
  return cleaned
}

export function nodeLabels(node: GraphNode): string[] {
  return [node.name, ...(node.aliases ?? [])]
}

function mergeAliases(node: GraphNode, extra: unknown[]): void {
  const seen = new Set([node.name.toLowerCase(), ...node.aliases.map((a) => a.toLowerCase())])
  for (const raw of extra) {
    const alias = cleanText(raw, MAX_NAME)
    if (alias && !seen.has(alias.toLowerCase())) {
      node.aliases.push(alias)
      seen.add(alias.toLowerCase())
    }
  }
}

export function isSensitiveEdge(graph: Graph, edge: GraphEdge): boolean {
  if (edge.sensitivity === "sensitive") return true
  for (const key of ["source", "target"] as const) {
    const node = graph.nodes[edge[key]]
    if (node && node.sensitivity === "sensitive") return true
  }
  return false
}

export function factView(graph: Graph, edge: GraphEdge): FactView {
  return {
    id: edge.id,
    text: edge.text,
    type: edge.type,
    source_kind: edge.source_kind,
    confidence: edge.confidence,
    last_seen: edge.last_seen,
    sensitivity: isSensitiveEdge(graph, edge) ? "sensitive" : "normal",
    nodes: [edge.source, edge.target].map((id) => graph.nodes[id]?.name ?? id),
  }
}

function isCurrent(edge: GraphEdge, today: string): boolean {
  if (edge.status !== "active") return false
  const until = edge.valid_until
  return !until || until.slice(0, 10) >= today
}

// ---------------------------------------------------------------- node resolution

function findNode(graph: Graph, name: string, type?: string): GraphNode | undefined {
  const needle = name.toLowerCase()
  const matches = Object.values(graph.nodes).filter(
    (n) => n.status === "active" && nodeLabels(n).some((l) => l.toLowerCase() === needle),
  )
  if (type) {
    const same = matches.find((n) => n.type === type)
    if (same) return same
  }
  return matches[0]
}

function createNode(
  graph: Graph, type: string, name: string, stamp: string,
  aliases: unknown[] = [], summary = "", sensitivity: "normal" | "sensitive" = "normal",
): GraphNode {
  const id = newId("n", graph.nodes)
  const node: GraphNode = {
    id, type: type as GraphNode["type"], name, aliases: [], summary, sensitivity,
    status: "active", first_seen: stamp, last_seen: stamp,
  }
  mergeAliases(node, aliases)
  graph.nodes[id] = node
  return node
}

function resolve(graph: Graph, ref: unknown, stamp: string, role: string): GraphNode {
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const r = ref as AnyOp
    const name = cleanText(r.name, MAX_NAME)
    if (!name) throw new OpError(`${role}: node name is required`)
    if (typeof r.type !== "string" || !NODE_TYPES.has(r.type)) {
      throw new OpError(`${role}: unknown node type ${JSON.stringify(r.type)}`)
    }
    return findNode(graph, name, r.type) ?? createNode(graph, r.type, name, stamp)
  }
  if (typeof ref === "string" && ref.trim()) {
    const direct = Object.prototype.hasOwnProperty.call(graph.nodes, ref) ? graph.nodes[ref] : undefined
    if (direct) {
      if (direct.status !== "active") throw new OpError(`${role}: node ${JSON.stringify(ref)} is outdated`)
      return direct
    }
    const node = findNode(graph, cleanText(ref, MAX_NAME))
    if (!node) throw new OpError(`${role}: unknown node ${JSON.stringify(ref)}`)
    return node
  }
  throw new OpError(`${role}: a node id, name or {name, type} is required`)
}

function getEdge(graph: Graph, op: AnyOp): GraphEdge {
  const id = typeof op.id === "string" ? op.id : null
  const edge = id !== null && Object.prototype.hasOwnProperty.call(graph.edges, id) ? graph.edges[id] : undefined
  if (!edge) throw new OpError(`unknown fact id ${JSON.stringify(op.id)}`)
  return edge
}

// ---------------------------------------------------------------- ops (each validates before it mutates)

function opAddNode(graph: Graph, op: AnyOp, stamp: string): void {
  const name = cleanText(op.name, MAX_NAME)
  const type = op.type
  if (!name) throw new OpError("name is required")
  if (typeof type !== "string" || !NODE_TYPES.has(type)) throw new OpError(`unknown node type ${JSON.stringify(type)}`)
  const sensitivity = (op.sensitivity ?? "normal") as string
  if (!SENSITIVITIES.has(sensitivity)) throw new OpError(`invalid sensitivity ${JSON.stringify(sensitivity)}`)
  const aliases = op.aliases ?? []
  if (!Array.isArray(aliases)) throw new OpError("aliases must be a list")
  const summary = cleanText(op.summary ?? "", MAX_TEXT)
  const existing = findNode(graph, name, type)
  if (existing) {
    mergeAliases(existing, aliases)
    if (summary && !existing.summary) existing.summary = summary
    if (sensitivity === "sensitive") existing.sensitivity = "sensitive"
    existing.last_seen = stamp
    return
  }
  createNode(graph, type, name, stamp, aliases, summary, sensitivity as "normal" | "sensitive")
}

function opAddFact(graph: Graph, op: AnyOp, stamp: string): void {
  const text = cleanText(op.text, MAX_TEXT)
  if (!text) throw new OpError("text is required")
  const edgeType = parseEdgeType(op.type)
  const kind = op.source_kind
  if (typeof kind !== "string" || !SOURCE_KINDS.has(kind)) throw new OpError("source_kind must be 'said' or 'inferred'")
  const confidence = parseConfidence(op.confidence)
  if (kind === "inferred" && confidence > INFERRED_MAX_CONFIDENCE) {
    throw new OpError(`inferred facts must have confidence <= ${INFERRED_MAX_CONFIDENCE}`)
  }
  const evidence = parseEvidence(op.evidence)
  const validFrom = parseDate(op.valid_from)
  const validUntil = parseDate(op.valid_until)
  let sensitivity = op.sensitivity as string | undefined | null
  if (sensitivity !== undefined && sensitivity !== null && !SENSITIVITIES.has(sensitivity)) {
    throw new OpError(`invalid sensitivity ${JSON.stringify(sensitivity)}`)
  }
  // Endpoints are resolved last: this is the only step that may create nodes.
  const before = new Set(Object.keys(graph.nodes))
  let source: GraphNode
  let target: GraphNode
  try {
    source = resolve(graph, op.source, stamp, "source")
    target = resolve(graph, op.target, stamp, "target")
    if (source.id === target.id) throw new OpError("source and target must be different nodes")
  } catch (err) {
    for (const id of Object.keys(graph.nodes)) if (!before.has(id)) delete graph.nodes[id]
    throw err
  }
  if (sensitivity === undefined || sensitivity === null) {
    sensitivity = source.sensitivity === "sensitive" || target.sensitivity === "sensitive" ? "sensitive" : "normal"
  }

  const key = normText(text)
  for (const edge of Object.values(graph.edges)) {
    if (
      edge.status === "active" && edge.source === source.id && edge.target === target.id &&
      edge.type === edgeType && normText(edge.text) === key
    ) {
      const cap = edge.source_kind === "said" ? 1.0 : INFERRED_MAX_CONFIDENCE
      const bumped = Math.min(cap, Math.max(edge.confidence, confidence) + DEDUPE_CONFIDENCE_BUMP)
      edge.confidence = Math.round(bumped * 10000) / 10000
      edge.mention_count += 1
      edge.last_seen = stamp
      edge.evidence = mergeEvidence(edge.evidence, evidence)
      if (sensitivity === "sensitive") edge.sensitivity = "sensitive"
      return
    }
  }
  const id = newId("e", graph.edges)
  graph.edges[id] = {
    id, source: source.id, target: target.id, type: edgeType, text,
    source_kind: kind as GraphEdge["source_kind"], confidence, evidence,
    sensitivity: sensitivity as GraphEdge["sensitivity"], status: "active",
    first_seen: stamp, last_seen: stamp, valid_from: validFrom, valid_until: validUntil, mention_count: 1,
  }
  source.last_seen = stamp
  target.last_seen = stamp
}

function opUpdateFact(graph: Graph, op: AnyOp, stamp: string): void {
  const edge = getEdge(graph, op)
  const changes: Partial<GraphEdge> = {}
  if (op.text !== undefined && op.text !== null) {
    const text = cleanText(op.text, MAX_TEXT)
    if (!text) throw new OpError("text must not be empty")
    changes.text = text
  }
  if (op.confidence !== undefined && op.confidence !== null) {
    const confidence = parseConfidence(op.confidence)
    if (edge.source_kind === "inferred" && confidence > INFERRED_MAX_CONFIDENCE) {
      throw new OpError(`inferred facts must have confidence <= ${INFERRED_MAX_CONFIDENCE}`)
    }
    changes.confidence = confidence
  }
  if ("valid_until" in op) changes.valid_until = parseDate(op.valid_until)
  const extra = parseEvidence(op.evidence_add)
  if (Object.keys(changes).length === 0 && extra.length === 0) throw new OpError("nothing to update")
  Object.assign(edge, changes)
  edge.evidence = mergeEvidence(edge.evidence, extra)
  edge.last_seen = stamp
}

function opOutdateFact(graph: Graph, op: AnyOp, stamp: string): void {
  const edge = getEdge(graph, op)
  if (!cleanText(op.reason, 300)) throw new OpError("reason is required")
  edge.status = "outdated"
  edge.last_seen = stamp
}

function opMergeNodes(graph: Graph, op: AnyOp, stamp: string): void {
  if (typeof op.keep !== "string" || typeof op.drop !== "string") throw new OpError("keep and drop must be node ids or names")
  const keep = resolve(graph, op.keep, stamp, "keep")
  const drop = resolve(graph, op.drop, stamp, "drop")
  if (keep.id === drop.id) throw new OpError("cannot merge a node into itself")
  if (drop.id === HUB_ID) throw new OpError("the hub node cannot be dropped")
  mergeAliases(keep, [drop.name, ...drop.aliases])
  if (!keep.summary && drop.summary) keep.summary = drop.summary
  if (drop.sensitivity === "sensitive") keep.sensitivity = "sensitive"
  if (drop.first_seen < keep.first_seen) keep.first_seen = drop.first_seen
  keep.last_seen = [keep.last_seen, drop.last_seen, stamp].reduce((a, b) => (a > b ? a : b))
  drop.status = "outdated"
  drop.last_seen = stamp
  for (const edge of Object.values(graph.edges)) {
    let repointed = false
    for (const key of ["source", "target"] as const) {
      if (edge[key] === drop.id) {
        edge[key] = keep.id
        repointed = true
      }
    }
    if (repointed && edge.source === edge.target) edge.status = "outdated"
  }
  // Collapse facts that became identical after re-pointing.
  const seen = new Map<string, GraphEdge>()
  for (const edge of Object.values(graph.edges)) {
    if (edge.status !== "active") continue
    const ident = JSON.stringify([edge.source, edge.target, edge.type, normText(edge.text)])
    const first = seen.get(ident)
    if (!first) {
      seen.set(ident, edge)
      continue
    }
    first.mention_count += edge.mention_count
    first.evidence = mergeEvidence(first.evidence, edge.evidence)
    first.confidence = Math.max(first.confidence, edge.confidence)
    if (edge.last_seen > first.last_seen) first.last_seen = edge.last_seen
    edge.status = "outdated"
  }
}

function opSetSensitivity(graph: Graph, op: AnyOp): void {
  const value = op.value
  if (typeof value !== "string" || !SENSITIVITIES.has(value)) throw new OpError(`invalid sensitivity ${JSON.stringify(value)}`)
  if (op.target === "node") {
    const id = typeof op.id === "string" ? op.id : null
    const node = id !== null && Object.prototype.hasOwnProperty.call(graph.nodes, id) ? graph.nodes[id] : undefined
    if (!node) throw new OpError(`unknown node id ${JSON.stringify(op.id)}`)
    node.sensitivity = value as GraphNode["sensitivity"]
  } else if (op.target === "fact") {
    getEdge(graph, op).sensitivity = value as GraphEdge["sensitivity"]
  } else {
    throw new OpError("target must be 'node' or 'fact'")
  }
}

/**
 * Apply a diff. Valid ops are applied, invalid ones are reported. The input graph is never mutated;
 * when nothing was applied the very same graph object is returned.
 */
export function applyDiff(
  graph: Graph,
  diff: { ops?: unknown } | null | undefined,
  opts: { reason: string; now: Date },
): ApplyResult {
  const reason = cleanText(opts.reason, 200)
  const ops = diff && typeof diff === "object" ? diff.ops : undefined
  if (!Array.isArray(ops)) {
    return { graph, applied: 0, reason, rejected: [{ op: null, index: -1, error: "diff must be an object with an 'ops' list" }] }
  }
  const stamp = iso(opts.now)
  const work = structuredClone(graph)
  let applied = 0
  const rejected: Rejected[] = []
  ops.forEach((raw: unknown, index: number) => {
    const name =
      raw && typeof raw === "object" && typeof (raw as AnyOp).op === "string" ? ((raw as AnyOp).op as string) : null
    if (index >= MAX_OPS) {
      rejected.push({ op: name, index, error: `too many ops (max ${MAX_OPS} per diff)` })
      return
    }
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpError("op must be an object")
      const op = raw as AnyOp
      switch (name) {
        case "add_node": opAddNode(work, op, stamp); break
        case "add_fact": opAddFact(work, op, stamp); break
        case "update_fact": opUpdateFact(work, op, stamp); break
        case "outdate_fact": opOutdateFact(work, op, stamp); break
        case "merge_nodes": opMergeNodes(work, op, stamp); break
        case "set_sensitivity": opSetSensitivity(work, op); break
        default: throw new OpError(`unknown op: ${JSON.stringify(name)}`)
      }
      applied += 1
    } catch (err) {
      if (!(err instanceof OpError)) throw err
      rejected.push({ op: name, index, error: err.message })
    }
  })
  if (applied === 0) return { graph, applied: 0, rejected, reason }
  work.updated_at = stamp
  return { graph: work, applied, rejected, reason }
}

// ---------------------------------------------------------------- reading

function visibleEdges(graph: Graph, includeSensitive: boolean, now: Date): GraphEdge[] {
  const today = now.toISOString().slice(0, 10)
  return Object.values(graph.edges).filter(
    (e) => isCurrent(e, today) && (includeSensitive || !isSensitiveEdge(graph, e)),
  )
}

const byLastSeenDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)

export function search(
  graph: Graph, query: string, k = 8, includeSensitive = false, now: Date = new Date(),
): FactView[] {
  const edges = visibleEdges(graph, includeSensitive, now)
  if (edges.length === 0 || typeof query !== "string" || !query.trim()) return []
  const q = tokenize(query)
  if (q.size === 0) return []
  const scored: { score: number; edge: GraphEdge }[] = []
  for (const edge of edges) {
    const doc = tokenize(edge.text)
    for (const key of ["source", "target"] as const) {
      const node = graph.nodes[edge[key]]
      if (node) for (const label of nodeLabels(node)) for (const t of tokenize(label)) doc.add(t)
    }
    let overlap = 0
    for (const t of q) if (doc.has(t)) overlap += 1
    const score = overlap / q.size
    if (score > SEARCH_THRESHOLD) scored.push({ score, edge })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.edge.confidence - a.edge.confidence ||
      byLastSeenDesc(a.edge.last_seen, b.edge.last_seen),
  )
  return scored.slice(0, Math.max(0, k)).map((s) => factView(graph, s.edge))
}

export function coreProfile(
  graph: Graph, maxItems = 12, includeSensitive = false, now: Date = new Date(),
): FactView[] {
  const edges = visibleEdges(graph, includeSensitive, now).filter(
    (e) => e.confidence >= 0.6 && !DIARY_EDGE_TYPES.has(e.type),
  )
  edges.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      byLastSeenDesc(a.last_seen, b.last_seen) ||
      b.mention_count - a.mention_count,
  )
  const groups = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    const list = groups.get(e.type)
    if (list) list.push(e)
    else groups.set(e.type, [e])
  }
  const picked: GraphEdge[] = []
  while (groups.size > 0 && picked.length < maxItems) {
    for (const type of [...groups.keys()]) {
      const list = groups.get(type)!
      picked.push(list.shift()!)
      if (list.length === 0) groups.delete(type)
      if (picked.length >= maxItems) break
    }
  }
  return picked.map((e) => factView(graph, e))
}
