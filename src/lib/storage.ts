// Browser persistence: IndexedDB ("zeneb-lite") behind a small interface, with an in-memory fallback.
// Operations never throw to callers: a failed write is logged, and a store holding corrupt data is reset.
import type { ChatMsg, DayLog, Graph, JournalEntry } from "@shared/types"
import { isGraph } from "./memory/graph"

export const DB_NAME = "zeneb-lite"
export const DB_VERSION = 2
export const MAX_SNAPSHOTS = 30

export type SettingKey = "aiName" | "lastSyncedAt" | "lastSavedAt"

export interface SnapshotRecord {
  at: string
  reason: string
  graph: Graph
}

export interface Storage {
  readonly kind: "indexeddb" | "memory"
  loadMessages(): Promise<ChatMsg[]>
  saveMessage(msg: ChatMsg): Promise<void>
  replaceMessages(msgs: ChatMsg[]): Promise<void>
  loadGraph(): Promise<Graph | null>
  saveGraph(graph: Graph): Promise<void>
  /** Keeps only the newest MAX_SNAPSHOTS. */
  addSnapshot(rec: SnapshotRecord): Promise<void>
  /** Oldest first. */
  listSnapshots(): Promise<SnapshotRecord[]>
  loadDayLogs(): Promise<DayLog[]>
  saveDayLog(log: DayLog): Promise<void>
  replaceDayLogs(logs: DayLog[]): Promise<void>
  getSetting(key: SettingKey): Promise<string | null>
  setSetting(key: SettingKey, value: string | null): Promise<void>
  getJournal(localDate: string): Promise<JournalEntry | null>
  putJournal(entry: JournalEntry): Promise<void>
  /** Newest first. */
  listJournals(): Promise<JournalEntry[]>
  getJournalImage(localDate: string): Promise<string | null>
  putJournalImage(localDate: string, dataUrl: string): Promise<void>
  clearAll(): Promise<void>
}

// ---------------------------------------------------------------- validation and ordering

const ID_RE = /^m_(\d+)_(\d+)$/

/** Chronological order: createdAt, then the numeric parts of the id (so counter 10 follows 9). */
export function compareMessages(a: ChatMsg, b: ChatMsg): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  const ma = ID_RE.exec(a.id)
  const mb = ID_RE.exec(b.id)
  if (ma && mb) return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2])
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function isMsg(v: unknown): v is ChatMsg {
  const m = v as ChatMsg
  return (
    !!m && typeof m === "object" && typeof m.id === "string" && typeof m.content === "string" &&
    typeof m.createdAt === "string" && (m.role === "user" || m.role === "assistant")
  )
}

function isDayLog(v: unknown): v is DayLog {
  const d = v as DayLog
  return !!d && typeof d === "object" && typeof d.localDate === "string" && Array.isArray(d.notes) &&
    typeof d.coverage === "object" && d.coverage !== null
}

function isSnapshot(v: unknown): v is SnapshotRecord {
  const s = v as SnapshotRecord
  return !!s && typeof s === "object" && typeof s.at === "string" && isGraph(s.graph)
}

function isJournal(v: unknown): v is JournalEntry {
  const j = v as JournalEntry
  return !!j && typeof j === "object" && typeof j.localDate === "string" && Array.isArray(j.paragraphs) &&
    typeof j.title === "string"
}

function isJournalImage(v: unknown): v is { localDate: string; dataUrl: string } {
  const j = v as { localDate: string; dataUrl: string }
  return !!j && typeof j === "object" && typeof j.localDate === "string" && typeof j.dataUrl === "string"
}

const byDateDesc = (a: JournalEntry, b: JournalEntry) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0)

const clone = <T>(v: T): T => structuredClone(v)

// ---------------------------------------------------------------- in-memory implementation

export function createMemoryStorage(): Storage {
  let messages = new Map<string, ChatMsg>()
  let graph: Graph | null = null
  let snapshots: SnapshotRecord[] = []
  let dayLogs = new Map<string, DayLog>()
  let settings = new Map<string, string | null>()
  let journals = new Map<string, JournalEntry>()
  let journalImages = new Map<string, string>()
  return {
    kind: "memory",
    async loadMessages() {
      return [...messages.values()].map(clone).sort(compareMessages)
    },
    async saveMessage(msg) {
      messages.set(msg.id, clone(msg))
    },
    async replaceMessages(msgs) {
      messages = new Map(msgs.map((m) => [m.id, clone(m)]))
    },
    async loadGraph() {
      return graph ? clone(graph) : null
    },
    async saveGraph(g) {
      graph = clone(g)
    },
    async addSnapshot(rec) {
      snapshots.push(clone(rec))
      if (snapshots.length > MAX_SNAPSHOTS) snapshots = snapshots.slice(-MAX_SNAPSHOTS)
    },
    async listSnapshots() {
      return snapshots.map(clone)
    },
    async loadDayLogs() {
      return [...dayLogs.values()].map(clone).sort((a, b) => (a.localDate < b.localDate ? -1 : 1))
    },
    async saveDayLog(log) {
      dayLogs.set(log.localDate, clone(log))
    },
    async replaceDayLogs(logs) {
      dayLogs = new Map(logs.map((l) => [l.localDate, clone(l)]))
    },
    async getSetting(key) {
      return settings.get(key) ?? null
    },
    async setSetting(key, value) {
      settings.set(key, value)
    },
    async getJournal(date) {
      const j = journals.get(date)
      return j ? clone(j) : null
    },
    async putJournal(entry) {
      journals.set(entry.localDate, clone(entry))
    },
    async listJournals() {
      return [...journals.values()].map(clone).sort(byDateDesc)
    },
    async getJournalImage(date) {
      return journalImages.get(date) ?? null
    },
    async putJournalImage(date, dataUrl) {
      journalImages.set(date, dataUrl)
    },
    async clearAll() {
      journals = new Map()
      journalImages = new Map()
      messages = new Map()
      graph = null
      snapshots = []
      dayLogs = new Map()
      settings = new Map()
    },
  }
}

// ---------------------------------------------------------------- IndexedDB implementation

const STORES = ["messages", "graph", "snapshots", "dayLogs", "settings", "journals", "journalImages"] as const
type StoreName = (typeof STORES)[number]
const GRAPH_KEY = "main"

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
  })
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      // Additive only: every store that already exists (and its records) is left untouched.
      const db = req.result
      const has = (name: string) => db.objectStoreNames.contains(name)
      if (!has("messages")) db.createObjectStore("messages", { keyPath: "id" })
      if (!has("graph")) db.createObjectStore("graph")
      if (!has("snapshots")) db.createObjectStore("snapshots", { autoIncrement: true })
      if (!has("dayLogs")) db.createObjectStore("dayLogs", { keyPath: "localDate" })
      if (!has("settings")) db.createObjectStore("settings")
      if (!has("journals")) db.createObjectStore("journals", { keyPath: "localDate" })
      if (!has("journalImages")) db.createObjectStore("journalImages", { keyPath: "localDate" })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB"))
    req.onblocked = () => reject(new Error("IndexedDB open was blocked"))
  })
}

function createIdbStorage(db: IDBDatabase): Storage {
  const warn = (what: string, err: unknown) =>
    console.warn(`storage: ${what} failed`, err instanceof Error ? err.message : err)

  async function run<T>(what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      warn(what, err)
      return fallback
    }
  }

  async function readAll(name: StoreName): Promise<unknown[]> {
    const tx = db.transaction(name, "readonly")
    return wrap(tx.objectStore(name).getAll())
  }

  async function clearStore(name: StoreName): Promise<void> {
    const tx = db.transaction(name, "readwrite")
    tx.objectStore(name).clear()
    await txDone(tx)
  }

  /** Reads a whole store; if anything in it is malformed the store is reset and [] is returned. */
  async function readValidated<T>(name: StoreName, ok: (v: unknown) => v is T): Promise<T[]> {
    const rows = await readAll(name)
    if (rows.every(ok)) return rows as T[]
    console.warn(`storage: ${name} held corrupt data and was reset`)
    await clearStore(name)
    return []
  }

  async function replaceStore(name: "messages" | "dayLogs", rows: unknown[]): Promise<void> {
    const tx = db.transaction(name, "readwrite")
    const store = tx.objectStore(name)
    store.clear()
    for (const row of rows) store.put(row)
    await txDone(tx)
  }

  async function putOne(name: StoreName, value: unknown, key?: string): Promise<void> {
    const tx = db.transaction(name, "readwrite")
    if (key === undefined) tx.objectStore(name).put(value)
    else tx.objectStore(name).put(value, key)
    await txDone(tx)
  }

  return {
    kind: "indexeddb",
    loadMessages: () =>
      run("loadMessages", [] as ChatMsg[], async () => (await readValidated("messages", isMsg)).sort(compareMessages)),
    saveMessage: (msg) => run("saveMessage", undefined, () => putOne("messages", msg)),
    replaceMessages: (msgs) => run("replaceMessages", undefined, () => replaceStore("messages", msgs)),
    loadGraph: () =>
      run("loadGraph", null as Graph | null, async () => {
        const tx = db.transaction("graph", "readonly")
        const value = await wrap(tx.objectStore("graph").get(GRAPH_KEY))
        if (value === undefined) return null
        if (isGraph(value)) return value
        console.warn("storage: graph held corrupt data and was reset")
        await clearStore("graph")
        return null
      }),
    saveGraph: (graph) => run("saveGraph", undefined, () => putOne("graph", graph, GRAPH_KEY)),
    addSnapshot: (rec) =>
      run("addSnapshot", undefined, async () => {
        const tx = db.transaction("snapshots", "readwrite")
        const store = tx.objectStore("snapshots")
        store.add(rec)
        const keysReq = store.getAllKeys()
        keysReq.onsuccess = () => {
          const keys = keysReq.result
          for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SNAPSHOTS))) store.delete(key)
        }
        await txDone(tx)
      }),
    listSnapshots: () => run("listSnapshots", [] as SnapshotRecord[], () => readValidated("snapshots", isSnapshot)),
    loadDayLogs: () =>
      run("loadDayLogs", [] as DayLog[], async () =>
        (await readValidated("dayLogs", isDayLog)).sort((a, b) => (a.localDate < b.localDate ? -1 : 1))),
    saveDayLog: (log) => run("saveDayLog", undefined, () => putOne("dayLogs", log)),
    replaceDayLogs: (logs) => run("replaceDayLogs", undefined, () => replaceStore("dayLogs", logs)),
    getSetting: (key) =>
      run("getSetting", null as string | null, async () => {
        const tx = db.transaction("settings", "readonly")
        const value = await wrap(tx.objectStore("settings").get(key))
        return typeof value === "string" ? value : null
      }),
    setSetting: (key, value) =>
      run("setSetting", undefined, async () => {
        const tx = db.transaction("settings", "readwrite")
        if (value === null) tx.objectStore("settings").delete(key)
        else tx.objectStore("settings").put(value, key)
        await txDone(tx)
      }),
    getJournal: (date) =>
      run("getJournal", null as JournalEntry | null, async () => {
        const tx = db.transaction("journals", "readonly")
        const value = await wrap(tx.objectStore("journals").get(date))
        return isJournal(value) ? value : null
      }),
    putJournal: (entry) => run("putJournal", undefined, () => putOne("journals", entry)),
    listJournals: () =>
      run("listJournals", [] as JournalEntry[], async () => (await readValidated("journals", isJournal)).sort(byDateDesc)),
    getJournalImage: (date) =>
      run("getJournalImage", null as string | null, async () => {
        const tx = db.transaction("journalImages", "readonly")
        const value = await wrap(tx.objectStore("journalImages").get(date))
        return isJournalImage(value) ? value.dataUrl : null
      }),
    putJournalImage: (date, dataUrl) => run("putJournalImage", undefined, () => putOne("journalImages", { localDate: date, dataUrl })),
    clearAll: () =>
      run("clearAll", undefined, async () => {
        const tx = db.transaction([...STORES], "readwrite")
        for (const name of STORES) tx.objectStore(name).clear()
        await txDone(tx)
      }),
  }
}

// ---------------------------------------------------------------- opening

/**
 * Opens IndexedDB, or falls back to memory when it is unavailable (private mode, blocked, old browser).
 * `factory` exists for tests: pass null to force the fallback.
 */
export async function openStorage(factory?: IDBFactory | null): Promise<Storage> {
  const idb = factory === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : factory
  if (!idb) return createMemoryStorage()
  try {
    return createIdbStorage(await openDb(idb))
  } catch (err) {
    console.warn("storage: IndexedDB unavailable, using memory for this session", err instanceof Error ? err.message : err)
    return createMemoryStorage()
  }
}

let shared: Promise<Storage> | null = null

/** The app-wide storage (opened once). */
export function getStorage(): Promise<Storage> {
  if (!shared) shared = openStorage()
  return shared
}

/** Tests only: forget the shared instance so the next getStorage() opens again. */
export function __resetSharedStorage(): void {
  shared = null
}
