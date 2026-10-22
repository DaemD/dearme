// Token signing and the secret checks (password, admin key). Everything compares in constant time.
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { VercelRequest, VercelResponse } from "@vercel/node"
import { fail, headerOf } from "./http.js"

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const MIN_SECRET_LENGTH = 16

export const USERNAME = "zeneb"

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url")

/** SECRET_KEY, or null when it is unset or too short (then nothing may be served). */
export function signingSecret(): string | null {
  const s = process.env.SECRET_KEY
  return s && s.length >= MIN_SECRET_LENGTH ? s : null
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest()
}

/** base64url(payload).base64url(signature), payload = {sub, exp}. */
export function signToken(nowMs: number = Date.now()): string {
  const secret = signingSecret()
  if (!secret) throw new Error("SECRET_KEY is not set")
  const payload = b64(JSON.stringify({ sub: USERNAME, exp: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS }))
  return `${payload}.${b64(sign(payload, secret))}`
}

export function verifyToken(token: string, nowMs: number = Date.now()): boolean {
  const secret = signingSecret()
  if (!secret || typeof token !== "string") return false
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  const [payload, sig] = parts
  const given = Buffer.from(sig, "base64url")
  if (given.toString("base64url") !== sig) return false // not canonical base64url
  const expected = sign(payload, secret)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown }
    return data.sub === USERNAME && typeof data.exp === "number" && data.exp > nowMs / 1000
  } catch {
    return false
  }
}

/** Constant-time string comparison (hashing first makes the buffers equal length). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest()
  const hb = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Gate for protected endpoints. Returns true when the caller may continue; otherwise the response is sent.
 * A missing/short SECRET_KEY refuses everything with a generic 500; a bad token never says why.
 */
export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  if (!signingSecret()) {
    fail(res, 500, "The server is not set up correctly.")
    return false
  }
  const m = /^Bearer (.+)$/.exec(headerOf(req, "authorization"))
  if (!m || !verifyToken(m[1])) {
    fail(res, 401, "Not authenticated")
    return false
  }
  return true
}
