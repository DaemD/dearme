import type { VercelRequest, VercelResponse } from "@vercel/node"

const CONTENT_KEY  = "pf:content"
const PASSWORD_KEY = "pf:password"

function cfg() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || ""
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  return url && token ? { url, token } : null
}

async function rcommand(args: unknown[]): Promise<unknown> {
  const r = cfg()
  if (!r) return null
  try {
    const res = await fetch(r.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { result?: unknown }
    return j.result ?? null
  } catch {
    return null
  }
}

async function rget(key: string): Promise<string | null> {
  const v = await rcommand(["GET", key])
  return typeof v === "string" ? v : null
}

async function rset(key: string, value: string): Promise<void> {
  await rcommand(["SET", key, value])
}

async function getPassword(): Promise<string> {
  const stored = await rget(PASSWORD_KEY)
  return stored || process.env.PORTFOLIO_PASSWORD || "CHANGE_ME"
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Access-Control-Allow-Origin", "*")

  try {
    if (req.method === "GET") {
      const raw = await rget(CONTENT_KEY)
      let content = null
      try { if (raw) content = JSON.parse(raw) } catch {}
      res.json({ content })
      return
    }

    if (req.method === "PUT") {
      const body = req.body as Record<string, unknown>
      if (!body || typeof body !== "object") { res.status(400).json({ error: "Bad request." }); return }
      const { password, content, _checkOnly } = body

      const correct = await getPassword()
      if (typeof password !== "string" || password !== correct) {
        res.status(401).json({ error: "Incorrect password." }); return
      }

      // Password-only check — no save needed
      if (_checkOnly) { res.json({ ok: true }); return }

      if (!content || typeof content !== "object" || Array.isArray(content)) {
        res.status(400).json({ error: "Invalid content." }); return
      }
      if (!cfg()) { res.status(503).json({ error: "Storage not configured." }); return }
      const mutable = { ...(content as Record<string, unknown>) }
      const newPw = typeof mutable._newPassword === "string" ? mutable._newPassword : null
      delete mutable._newPassword
      await rset(CONTENT_KEY, JSON.stringify(mutable))
      if (newPw && newPw.length >= 4) await rset(PASSWORD_KEY, newPw)
      res.json({ ok: true })
      return
    }

    res.status(405).end()
  } catch (err) {
    console.error("[portfolio/content]", err)
    res.status(500).json({ error: "Internal error." })
  }
}
