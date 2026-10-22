import { route, fail, bodyOf } from "./_lib/http"
import { get, set, isConfigured } from "./_lib/store"

const CONTENT_KEY  = "zeneb:portfolio:content"
const PASSWORD_KEY = "zeneb:portfolio:password"

/** Active password: Redis takes priority over the env var, so Zeneb can change it from the page. */
async function getPassword(): Promise<string> {
  if (isConfigured()) {
    const stored = await get(PASSWORD_KEY)
    if (stored) return stored
  }
  return process.env.PORTFOLIO_PASSWORD || "CHANGE_ME"
}

export default route(["GET", "PUT"], async (req, res) => {
  if (req.method === "GET") {
    if (!isConfigured()) {
      res.json({ content: null })
      return
    }
    const raw = await get(CONTENT_KEY)
    let content: unknown = null
    if (raw) {
      try { content = JSON.parse(raw) } catch { content = null }
    }
    res.json({ content })
    return
  }

  // PUT — validate password, then persist content (and optionally a new password)
  const body = bodyOf(req)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(res, 400, "Invalid request body.")
  }
  const { password, content } = body as Record<string, unknown>
  if (typeof password !== "string") return fail(res, 400, "Missing password.")
  if (password !== (await getPassword())) return fail(res, 401, "Incorrect password.")
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return fail(res, 400, "Invalid content.")
  }
  if (!isConfigured()) return fail(res, 503, "Storage not configured.")

  // Pull out _newPassword before storing content
  const mutable = { ...(content as Record<string, unknown>) }
  const newPw = typeof mutable._newPassword === "string" ? mutable._newPassword : null
  delete mutable._newPassword

  await set(CONTENT_KEY, JSON.stringify(mutable))
  if (newPw && newPw.length >= 4) {
    await set(PASSWORD_KEY, newPw)
  }

  res.json({ ok: true })
})
