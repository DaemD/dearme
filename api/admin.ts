import type { VercelResponse } from "@vercel/node"
import type { SyncState } from "../shared/types"
import { safeEqual } from "./_lib/auth.js"
import { clientKey, fail, headerOf, route } from "./_lib/http.js"
import { recordFailure, recordSuccess, retryAfter } from "./_lib/ratelimit.js"
import * as store from "./_lib/store.js"

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
  if (what !== "graph" && what !== "state") return fail(res, 400, "what must be graph or state")
  let state: SyncState | null
  try {
    const raw = await store.get(store.STATE_KEY)
    state = raw ? (JSON.parse(raw) as SyncState) : null
  } catch {
    return fail(res, 502, "Backup storage is unavailable right now.")
  }
  const payload = what === "graph" ? (state?.graph ?? store.emptyGraph()) : state
  if (String(req.query?.download ?? "") === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="${what}.json"`)
  }
  res.status(200).json(payload)
})
