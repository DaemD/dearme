// The browser-side brain. The UI depends on this module only.
import type { ChatMsg, CoverageSlot, DayLog, Graph } from "@shared/types"
import { api, ApiRequestError, NETWORK_ERROR_MESSAGE, UNAUTHORIZED_MESSAGE } from "./api"
import { buildMemoryContext } from "./memory/context"
import {
  applyConsolidation, buildConsolidateRequest, consolidationDue,
} from "./memory/consolidation"
import { addDayNotes, dayLogNotes, localDateStr } from "./memory/daylog"
import { applyDiff, emptyGraph, hasEdges, isGraph, MAX_OPS, search } from "./memory/graph"
import { sanitiseLiveOps } from "./memory/sanitize"
import { getStorage } from "./storage"
import type { Storage } from "./storage"
import { __resetSync, restoreIfEmpty, scheduleBackup } from "./sync"
import {
  __resetJournal,
  __setJournalClock,
  __setMessageGetter,
  finaliseDueJournals,
  getJournalDates as _getJournalDates,
  getJournalEntry,
  getJournalImage,
  initJournal,
  journalStatus,
  lazyFetchImage,
  refreshJournal as _refreshJournal,
  retryJournalImage as _retryJournalImage,
  saveJournalEdit as _saveJournalEdit,
  scheduleDebounceRefresh,
  subscribeJournal,
} from "./journal"
import type { JournalEntry } from "@shared/types"

export interface JournalView { entry: JournalEntry; imageDataUrl: string | null }

export const HISTORY_LIMIT = 20
export const CONSOLIDATION_BACKOFF_MS = 15 * 60 * 1000
const MAX_EXTRACT_NODES = 40
const MAX_EXTRACT_FACTS = 8
const MAX_LIVE_NOTES = 3

export const ASSISTANT_UNAVAILABLE = "The assistant is unavailable right now. Please try again."

/** An error whose message is safe to show to the user. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineError"
  }
}

// ---------------------------------------------------------------- state

let clock: () => Date = () => new Date()
let storage: Storage | null = null
let messages: ChatMsg[] = []
let graph: Graph = emptyGraph()
let dayLogs = new Map<string, DayLog>()
let aiName: string | null = null
let counter = 0
let initPromise: Promise<void> | null = null
let needSeed = false
let consolidating = false
let backoffUntil = 0

const listeners = new Set<() => void>()
const background = new Set<Promise<unknown>>()

// A simple promise-chain mutex: every graph / day log write goes through it.
let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn())
  chain = run.catch(() => undefined)
  return run
}

function track(p: Promise<unknown>): void {
  const wrapped = p.catch((err) => console.warn("background task failed", err instanceof Error ? err.message : err))
  background.add(wrapped)
  void wrapped.then(() => background.delete(wrapped))
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch (err) {
      console.warn("listener failed", err instanceof Error ? err.message : err)
    }
  }
}

/** Tests only: replace the clock. Pass null to restore the real one. */
export function __setClock(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date())
  __setJournalClock(fn)
}

/** Tests only: wait until every fire-and-forget task (learning, consolidation) has finished. */
export async function __flushBackground(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background])
}

// ---------------------------------------------------------------- public reads

export function getMessages(): ChatMsg[] {
  return messages.slice()
}

export function getAiName(): string | null {
  return aiName
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------- AI name

function normaliseAiName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ")
}

/** "" when valid, otherwise a readable message. Same rules as the server. */
export function validateAiName(name: string): string {
  const n = normaliseAiName(name)
  if (!n) return "Please enter a name."
  if (n.length > 40) return "Names can be at most 40 characters long."
  if (!/^[\p{L}\p{N}_ .'’-]+$/u.test(n)) {
    return "Names can only use letters, numbers, spaces and the characters . ' - _"
  }
  return ""
}

export async function setAiName(name: string): Promise<string> {
  const problem = validateAiName(name)
  if (problem) throw new Error(problem)
  const clean = normaliseAiName(name)
  const store = await ensureStorage()
  aiName = clean
  await store.setSetting("aiName", clean)
  notify()
  scheduleBackup()
  return clean
}

// ---------------------------------------------------------------- init

async function ensureStorage(): Promise<Storage> {
  if (!storage) storage = await getStorage()
  return storage
}

async function persistGraph(prev: Graph, next: Graph, reason: string): Promise<void> {
  if (next === prev) return
  const store = await ensureStorage()
  // Keep the graph as it was before this change (the store keeps the newest 30).
  await store.addSnapshot({ at: clock().toISOString(), reason, graph: prev })
  graph = next
  await store.saveGraph(next)
}

async function trySeed(): Promise<void> {
  try {
    const seed = await api.seed()
    const ops = Array.isArray(seed?.ops) ? seed.ops : []
    await withLock(async () => {
      if (hasEdges(graph)) return
      let next = graph
      for (let i = 0; i < ops.length; i += MAX_OPS) {
        next = applyDiff(next, { ops: ops.slice(i, i + MAX_OPS) }, { reason: "seed", now: clock() }).graph
      }
      if (!hasEdges(next)) throw new Error("seed produced no facts")
      await persistGraph(graph, next, "seed")
    })
    needSeed = false
  } catch (err) {
    needSeed = true
    console.warn("seed failed; continuing with an empty graph", err instanceof Error ? err.message : err)
  }
}

async function doInit(): Promise<void> {
  const store = await ensureStorage()
  await restoreIfEmpty()
  messages = await store.loadMessages()
  const loaded = await store.loadGraph()
  graph = loaded && isGraph(loaded) ? loaded : emptyGraph(clock())
  dayLogs = new Map((await store.loadDayLogs()).map((l) => [l.localDate, l]))
  aiName = await store.getSetting("aiName")
  if (!hasEdges(graph)) await trySeed()
  // Wire journal's message getter to this engine's message list
  __setMessageGetter((date: string) =>
    messages
      .filter((m) => {
        const d = new Date(m.createdAt)
        const local = new Date(d.getTime() + 5 * 3600 * 1000)
        return local.toISOString().slice(0, 10) === date
      })
      .slice(-80)
      .map((m) => ({ id: m.id, role: m.role, content: m.content })),
  )
  await initJournal()
  track(maybeConsolidate())
  track(finaliseDueJournals())
  notify()
}

/** Idempotent. Calling it again retries the seed if the first attempt could not reach the server. */
export async function initEngine(): Promise<void> {
  const first = !initPromise
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null
      throw err
    })
  }
  await initPromise
  if (!first && needSeed && !hasEdges(graph)) await trySeed()
}

export async function resetLocalData(): Promise<void> {
  await __flushBackground()
  await chain
  const store = await ensureStorage()
  await store.clearAll()
  __resetSync()
  __resetJournal()
  messages = []
  graph = emptyGraph(clock())
  dayLogs = new Map()
  aiName = null
  initPromise = null
  needSeed = false
  consolidating = false
  backoffUntil = 0
  notify()
}

// ---------------------------------------------------------------- journal public API

export { journalStatus, subscribeJournal }

export function getJournalDates(): string[] {
  const todayChatted = messages.some((m) => {
    const d = new Date(m.createdAt)
    const local = new Date(d.getTime() + 5 * 3600 * 1000)
    return local.toISOString().slice(0, 10) === localDateStr(clock()) && m.role === "user"
  })
  return _getJournalDates(todayChatted)
}

export function getJournal(date: string): JournalView | null {
  const entry = getJournalEntry(date)
  if (!entry) return null
  const imageDataUrl = getJournalImage(date) ?? null
  // Lazy-fetch image if entry is finalised/ready but image not in memory
  if (entry.imageStatus === "ready" && !imageDataUrl) {
    void lazyFetchImage(date)
  }
  return { entry, imageDataUrl }
}

export async function refreshJournal(date?: string, opts?: { force?: boolean }): Promise<void> {
  return _refreshJournal(date, opts)
}

export async function saveJournalEdit(date: string, paragraphs: string[], title?: string): Promise<void> {
  return _saveJournalEdit(date, paragraphs, title)
}

export async function retryJournalImage(date: string): Promise<void> {
  return _retryJournalImage(date)
}

// ---------------------------------------------------------------- chat

function nextId(): string {
  counter += 1
  return `m_${clock().getTime()}_${counter}`
}

function userSafeMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0) return NETWORK_ERROR_MESSAGE
    if (err.status === 401) return UNAUTHORIZED_MESSAGE
    if (err.status === 400 && err.message) return err.message
  }
  return ASSISTANT_UNAVAILABLE
}

export async function sendMessage(text: string): Promise<{ user: ChatMsg; assistant: ChatMsg }> {
  const content = typeof text === "string" ? text.trim() : ""
  if (!content) throw new EngineError("Please type a message first.")
  await initEngine()
  const store = await ensureStorage()

  const user: ChatMsg = { id: nextId(), role: "user", content, createdAt: clock().toISOString() }
  messages.push(user)
  await store.saveMessage(user)
  notify()

  const now = clock()
  const memory = buildMemoryContext({ graph, dayLog: dayLogs.get(localDateStr(now)), message: content, now })
  const upTo = messages.indexOf(user)
  const history = messages
    .slice(Math.max(0, upTo + 1 - HISTORY_LIMIT), upTo + 1)
    .map((m) => ({ role: m.role, content: m.content }))

  let reply: string
  try {
    reply = (await api.chat({ history, aiName, memory })).reply
    if (typeof reply !== "string" || !reply.trim()) throw new Error("empty reply")
  } catch (err) {
    throw new EngineError(userSafeMessage(err))
  }

  const assistant: ChatMsg = { id: nextId(), role: "assistant", content: reply, createdAt: clock().toISOString() }
  messages.push(assistant)
  await store.saveMessage(assistant)
  notify()

  track(learn(user, assistant))
  scheduleDebounceRefresh()
  return { user, assistant }
}

// ---------------------------------------------------------------- learning

async function learn(user: ChatMsg, assistant: ChatMsg): Promise<void> {
  try {
    const now = clock()
    const localDate = localDateStr(now)
    const snapshot = graph
    const nodes = Object.values(snapshot.nodes)
      .filter((n) => n.status === "active" && n.type !== "day")
      .sort((a, b) => Number(b.id === "zeneb") - Number(a.id === "zeneb") || (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0))
      .slice(0, MAX_EXTRACT_NODES)
      .map((n) => ({ name: n.name, type: n.type, aliases: [...n.aliases] }))
    const facts = search(snapshot, user.content, MAX_EXTRACT_FACTS, true, now).map((f) => ({ id: f.id, text: f.text }))

    const res = await api.extract({
      userMessage: user.content,
      assistantReply: assistant.content,
      userMessageId: user.id,
      todayNotes: dayLogNotes(dayLogs.get(localDate)).map((n) => n.text),
      localDate,
      nodes,
      facts,
    })

    const notes = Array.isArray(res?.notes)
      ? res.notes.filter((n): n is string => typeof n === "string" && n.trim() !== "").slice(0, MAX_LIVE_NOTES)
      : []
    const coverage: Partial<Record<CoverageSlot, string>> =
      res?.coverage && typeof res.coverage === "object" && !Array.isArray(res.coverage) ? res.coverage : {}
    const ops = sanitiseLiveOps(res?.ops, localDate, user.id)

    await withLock(async () => {
      const store = await ensureStorage()
      if (ops.length > 0) {
        const result = applyDiff(graph, { ops }, { reason: `live:${user.id}`, now })
        for (const r of result.rejected) console.info("live op rejected:", r.op, r.error)
        await persistGraph(graph, result.graph, `live:${user.id}`)
      }
      if (notes.length > 0 || Object.keys(coverage).length > 0) {
        const log = addDayNotes(dayLogs.get(localDate), notes, coverage, now)
        dayLogs.set(localDate, log)
        await store.saveDayLog(log)
      }
    })
    await maybeConsolidate()
  } catch (err) {
    console.warn("learning step failed", err instanceof Error ? err.message : err)
  } finally {
    scheduleBackup()
  }
}

// ---------------------------------------------------------------- consolidation

async function maybeConsolidate(): Promise<void> {
  if (consolidating) return
  const now = clock()
  if (now.getTime() < backoffUntil) return
  const date = consolidationDue(messages, [...dayLogs.values()], now)
  if (!date) return
  consolidating = true
  try {
    const request = buildConsolidateRequest({ graph, messages, dayLog: dayLogs.get(date), localDate: date })
    const response = await api.consolidate(request)
    const done = await withLock(async () => {
      const out = applyConsolidation(graph, dayLogs.get(date), response, { localDate: date, messages, now })
      if (!out.changed) return false
      await persistGraph(graph, out.graph, `consolidate:${date}`)
      dayLogs.set(date, out.dayLog)
      const store = await ensureStorage()
      await store.saveDayLog(out.dayLog)
      return true
    })
    if (done) scheduleBackup()
    else backoffUntil = now.getTime() + CONSOLIDATION_BACKOFF_MS
  } catch (err) {
    backoffUntil = now.getTime() + CONSOLIDATION_BACKOFF_MS
    console.warn("consolidation failed", err instanceof Error ? err.message : err)
  } finally {
    consolidating = false
  }
}
