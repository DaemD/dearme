import type { SyncState } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import * as store from "./_lib/store.js"

const MAX_STATE_BYTES = 900_000
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)

/** Light shape check; the browser validates the content when it restores. Keeps only the known fields. */
function toState(b: unknown): SyncState | null {
  if (!isObj(b) || !isObj(b.graph) || !isObj(b.graph.nodes) || !isObj(b.graph.edges)) return null
  if (!Array.isArray(b.messages) || b.messages.length > 300) return null
  if (!Array.isArray(b.dayLogs) || b.dayLogs.length > 30) return null
  if (b.aiName !== null && typeof b.aiName !== "string") return null
  if (typeof b.savedAt !== "string") return null
  return { graph: b.graph, messages: b.messages, dayLogs: b.dayLogs, aiName: b.aiName, savedAt: b.savedAt } as unknown as SyncState
}

export default route(["GET", "PUT"], async (req, res) => {
  if (!requireAuth(req, res)) return

  if (req.method === "PUT") {
    const body = bodyOf(req)
    if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_STATE_BYTES) return fail(res, 413, "Backup is too large")
    const state = toState(body)
    if (!state) return fail(res, 400, "Invalid backup")
    if (!store.isConfigured()) return fail(res, 503, "Backup storage is not set up")
    try {
      await store.set(store.STATE_KEY, JSON.stringify(state))
    } catch {
      return fail(res, 502, "Backup storage is unavailable right now.")
    }
    return void res.status(200).json({ savedAt: state.savedAt })
  }

  if (!store.isConfigured()) return fail(res, 503, "Backup storage is not set up")
  try {
    const raw = await store.get(store.STATE_KEY)
    res.status(200).json({ state: raw ? (JSON.parse(raw) as SyncState) : null })
  } catch {
    fail(res, 502, "Backup storage is unavailable right now.")
  }
})
