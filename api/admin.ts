import type { VercelResponse } from "@vercel/node"
import type { JournalEntry, SyncState } from "../shared/types"
import { safeEqual } from "./_lib/auth.js"
import { clientKey, fail, headerOf, route } from "./_lib/http.js"
import { recordFailure, recordSuccess, retryAfter } from "./_lib/ratelimit.js"
import * as store from "./_lib/store.js"
import { entryKey, readIndex } from "./journal-sync.js"

const notFound = (res: VercelResponse) => fail(res, 404, "Not Found")

export default route(["GET"], async (req, res) => {
  const client = clientKey(req)
  // Locked-out guessers get the same 404 as everyone else, even with the right key.
  if ((await retryAfter("admin", client)) > 0) return notFound(res)

  const expected = process.env.ADMIN_KEY ?? ""
  const valid = expected.length >= 16 && safeEqual(headerOf(req, "x-admin-key"), expected)
  if (!valid) {
    await recordFailure("admin", client)
    return notFound(res)
  }
  await recordSuccess("admin", client)
  if (!store.isConfigured()) return fail(res, 503, "Backup storage is not set up")

  const what = String(req.query?.what ?? "graph")
  if (what !== "graph" && what !== "state" && what !== "journals") return fail(res, 400, "what must be graph, state or journals")
  let payload: unknown
  try {
    if (what === "journals") {
      const entries: JournalEntry[] = []
      for (const date of await readIndex()) {
        const raw = await store.get(entryKey(date))
        if (!raw) continue
        try {
          entries.push(JSON.parse(raw) as JournalEntry)
        } catch {
          // skip an unreadable entry
        }
      }
      entries.sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0))
      payload = { entries }
    } else {
      const raw = await store.get(store.STATE_KEY)
      const state = raw ? (JSON.parse(raw) as SyncState) : null
      payload = what === "graph" ? (state?.graph ?? store.emptyGraph()) : state
    }
  } catch {
    return fail(res, 502, "Backup storage is unavailable right now.")
  }
  if (String(req.query?.download ?? "") === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="${what}.json"`)
  }
  res.status(200).json(payload)
})
