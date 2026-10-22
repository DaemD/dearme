// Builds the private memory block that goes into the chat prompt.
import { COVERAGE_SLOTS, HUB_ID } from "@shared/types"
import type { DayLog, Graph } from "@shared/types"
import { coreProfile, nodeLabels, search, tokenize } from "./graph"
import type { FactView } from "./graph"
import { coverageGaps, dayLogCoverage, dayLogNotes } from "./daylog"

export const MAX_CONTEXT_CHARS = 2800
export const CORE_FACTS = 8
export const RELEVANT_FACTS = 8
export const TODAY_NOTES = 8

export const KNOWLEDGE_HEADER =
  "WHAT YOU KNOW ABOUT ZENEB (private notes: use naturally and sparingly, never recite them back):"
export const TODAY_HEADER = "TODAY SO FAR:"
const gapsLine = (gaps: string[]) =>
  `NOT YET KNOWN ABOUT TODAY: ${gaps.join(", ")}. If it fits naturally, you may work in at most one of these, ` +
  "never as a question list and never as an interrogation."

// Words too generic to unlock a sensitive fact on their own.
const GENERIC_KEYWORDS = new Set(
  `zeneb mostly along doesnt dont rest sometimes usually always really around about other there still
  would could their these those complicated relationship`.split(/\s+/),
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function mentionsLabel(message: string, label: string): boolean {
  const l = label.trim()
  if (!l) return false
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(l)}(?![\\p{L}\\p{N}_])`, "iu").test(message)
}

/** Names and aliases of the active sensitive nodes (for example Family, mum, dad), minus the hub. */
export function sensitiveLabels(graph: Graph): string[] {
  const labels: string[] = []
  for (const node of Object.values(graph.nodes)) {
    if (node.id === HUB_ID || node.status !== "active" || node.sensitivity !== "sensitive") continue
    for (const label of nodeLabels(node)) if (label) labels.push(label)
  }
  return labels
}

export function touchesSensitive(text: string, labels: string[]): boolean {
  return labels.some((l) => mentionsLabel(text, l))
}

function unlocked(fact: FactView, graph: Graph, message: string, messageTokens: Set<string>): boolean {
  if (fact.sensitivity !== "sensitive") return true
  const wanted = new Set(fact.nodes.map((n) => n.toLowerCase()))
  for (const node of Object.values(graph.nodes)) {
    if (node.id === HUB_ID || !wanted.has(node.name.toLowerCase())) continue
    if (nodeLabels(node).some((l) => mentionsLabel(message, l))) return true
  }
  for (const t of tokenize(fact.text)) {
    if (t.length >= 5 && !GENERIC_KEYWORDS.has(t) && messageTokens.has(t)) return true
  }
  return false
}

type Item = [priority: number, section: "knowledge" | "today" | "gaps", line: string]

function render(items: Item[]): string {
  const pick = (s: Item[1]) => items.filter((i) => i[1] === s).map((i) => i[2])
  const knowledge = pick("knowledge")
  const today = pick("today")
  const gaps = pick("gaps")
  const blocks: string[] = []
  if (knowledge.length) blocks.push([KNOWLEDGE_HEADER, ...knowledge].join("\n"))
  if (today.length) blocks.push([TODAY_HEADER, ...today].join("\n"))
  blocks.push(...gaps)
  return blocks.join("\n\n")
}

function build(graph: Graph, dayLog: DayLog | null | undefined, message: string, now: Date): string {
  const msg = typeof message === "string" ? message : ""
  const messageTokens = tokenize(msg)

  const core = coreProfile(graph, 40, true, now)
    .filter((f) => unlocked(f, graph, msg, messageTokens))
    .slice(0, CORE_FACTS)
  const seen = new Set(core.map((f) => f.id))
  const relevant: FactView[] = []
  if (msg.trim()) {
    for (const fact of search(graph, msg, 24, true, now)) {
      if (seen.has(fact.id) || !unlocked(fact, graph, msg, messageTokens)) continue
      seen.add(fact.id)
      relevant.push(fact)
      if (relevant.length >= RELEVANT_FACTS) break
    }
  }

  // Trim priority: a higher number is dropped first, and later lines before earlier ones.
  const items: Item[] = []
  for (const f of core) items.push([3, "knowledge", `- ${f.text}`])
  for (const f of relevant) items.push([1, "knowledge", `- ${f.text}`])

  // Notes and coverage follow the same rule as the graph: anything touching a sensitive topic stays out
  // of the prompt unless her current message brings that topic up again.
  const labels = sensitiveLabels(graph)
  const hide = labels.length > 0 && !touchesSensitive(msg, labels)
  const notes = dayLogNotes(dayLog).filter((n) => !(hide && touchesSensitive(n.text, labels)))
  for (const n of notes.slice(-TODAY_NOTES)) items.push([2, "today", `- ${n.text}`])
  const coverage = dayLogCoverage(dayLog)
  for (const slot of COVERAGE_SLOTS) {
    const value = coverage[slot]
    if (value !== undefined && !(hide && touchesSensitive(value, labels))) {
      items.push([4, "today", `- ${slot}: ${value}`])
    }
  }
  const gaps = coverageGaps(dayLog)
  if (gaps.length) items.push([5, "gaps", gapsLine(gaps)])

  let text = render(items)
  while (text.length > MAX_CONTEXT_CHARS && items.length) {
    let victim = 0
    for (let i = 1; i < items.length; i++) {
      if (items[i][0] >= items[victim][0]) victim = i
    }
    items.splice(victim, 1)
    text = render(items)
  }
  return text.slice(0, MAX_CONTEXT_CHARS)
}

/** The memory block for the chat prompt, or "" if anything at all goes wrong. */
export function buildMemoryContext(args: {
  graph: Graph
  dayLog?: DayLog | null
  message: string
  now: Date
}): string {
  try {
    return build(args.graph, args.dayLog, args.message, args.now)
  } catch (err) {
    console.warn("buildMemoryContext failed", err instanceof Error ? err.message : err)
    return ""
  }
}
