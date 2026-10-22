// Backup of the browser's state to the server (PUT /api/sync) and restore into an empty browser.
import type { ChatMsg, DayLog, SyncState } from "@shared/types"
import { api, ApiRequestError } from "./api"
import { hasEdges, isGraph } from "./memory/graph"
import { getStorage } from "./storage"

export const BACKUP_DEBOUNCE_MS = 2000
export const BACKUP_MESSAGES = 300
export const BACKUP_DAY_LOGS = 30

let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let rerun = false
let disabled = false

export async function buildSyncState(maxMessages = BACKUP_MESSAGES): Promise<SyncState | null> {
  const storage = await getStorage()
  const graph = await storage.loadGraph()
  if (!graph) return null
  const messages = (await storage.loadMessages()).slice(-maxMessages)
  const dayLogs = (await storage.loadDayLogs()).slice(-BACKUP_DAY_LOGS)
  return { graph, messages, dayLogs, aiName: await storage.getSetting("aiName"), savedAt: new Date().toISOString() }
}

async function backupOnce(): Promise<void> {
  const state = await buildSyncState()
  if (!state) return
  const storage = await getStorage()
  try {
    try {
      await api.putSync(state)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 413) {
        await api.putSync({ ...state, messages: state.messages.slice(-Math.floor(state.messages.length / 2)) })
      } else {
        throw err
      }
    }
    await storage.setSetting("lastSavedAt", state.savedAt)
    await storage.setSetting("lastSyncedAt", new Date().toISOString())
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 503) {
      disabled = true // backup storage is not configured: stop trying for this session
      return
    }
    console.warn("backup failed", err instanceof Error ? err.message : err)
  }
}

/** Runs a backup now (serialised; a request made while one is running triggers one more run). Never throws. */
export function backupNow(): Promise<void> {
  if (disabled) return Promise.resolve()
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    try {
      do {
        rerun = false
        if (disabled) break
        await backupOnce()
      } while (rerun)
    } catch (err) {
      console.warn("backup failed", err instanceof Error ? err.message : err)
    } finally {
      running = null
    }
  })()
  return running
}

/** Debounced (2 s trailing) backup. Never throws. */
export function scheduleBackup(): void {
  if (disabled) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void backupNow()
  }, BACKUP_DEBOUNCE_MS)
}

/** Tests: run a pending debounced backup immediately and wait for any running one. */
export async function __flushBackup(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
    await backupNow()
  } else if (running) {
    await running
  }
}

/** Tests / reset: drop any pending timer and re-enable backups. */
export function __resetSync(): void {
  if (timer) clearTimeout(timer)
  timer = null
  running = null
  rerun = false
  disabled = false
}

export function isBackupDisabled(): boolean {
  return disabled
}

function validMessages(v: unknown): ChatMsg[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (m): m is ChatMsg =>
      !!m && typeof m.id === "string" && typeof m.content === "string" && typeof m.createdAt === "string" &&
      (m.role === "user" || m.role === "assistant"),
  )
}

function validDayLogs(v: unknown): DayLog[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (d): d is DayLog =>
      !!d && typeof d.localDate === "string" && Array.isArray(d.notes) && typeof d.coverage === "object" && d.coverage !== null,
  )
}

/** When local storage has no messages and no graph edges, load the server backup (if any). Returns true if restored. */
export async function restoreIfEmpty(): Promise<boolean> {
  try {
    const storage = await getStorage()
    const messages = await storage.loadMessages()
    const graph = await storage.loadGraph()
    if (messages.length > 0 || (graph && hasEdges(graph))) return false
    const { state } = await api.getSync()
    if (!state || !isGraph(state.graph)) return false
    await storage.saveGraph(state.graph)
    await storage.replaceMessages(validMessages(state.messages))
    await storage.replaceDayLogs(validDayLogs(state.dayLogs))
    await storage.setSetting("aiName", typeof state.aiName === "string" && state.aiName ? state.aiName : null)
    if (typeof state.savedAt === "string") await storage.setSetting("lastSavedAt", state.savedAt)
    await storage.setSetting("lastSyncedAt", new Date().toISOString())
    return true
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.status === 503)) {
      console.warn("restore failed", err instanceof Error ? err.message : err)
    }
    return false
  }
}
