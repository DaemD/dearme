// Small shared HTTP helpers: method check, body-size limit, cache headers, JSON errors, client address.
import type { VercelRequest, VercelResponse } from "@vercel/node"

export const MAX_BODY_BYTES = 1_000_000

export function fail(res: VercelResponse, status: number, detail: string): void {
  res.status(status).json({ detail })
}

/** The request body as Vercel parsed it (undefined when absent). */
export function bodyOf(req: VercelRequest): unknown {
  const body = req.body as unknown
  if (typeof body === "string") {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  }
  return body
}

export function bodyBytes(req: VercelRequest): number {
  const declared = Number(req.headers?.["content-length"] ?? 0)
  const body = req.body as unknown
  if (body === undefined || body === null) return declared || 0
  const actual = Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body))
  return Math.max(declared || 0, actual)
}

export function headerOf(req: VercelRequest, name: string): string {
  const v = req.headers?.[name.toLowerCase()]
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/** Who is calling. Behind Vercel's proxy the right-most X-Forwarded-For entry is the one the proxy added. */
export function clientKey(req: VercelRequest): string {
  if (process.env.TRUST_PROXY_HEADERS !== "false") {
    const parts = headerOf(req, "x-forwarded-for").split(",").map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return req.socket?.remoteAddress || "unknown"
}

/** Wraps an endpoint: no-store caching, 405 for other methods, 413 for oversized bodies, no leaked errors. */
export function route(methods: string[], handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void) {
  return async function wrapped(req: VercelRequest, res: VercelResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store")
    if (!methods.includes(req.method ?? "")) {
      res.setHeader("Allow", methods.join(", "))
      return fail(res, 405, "Method Not Allowed")
    }
    if (bodyBytes(req) > MAX_BODY_BYTES) return fail(res, 413, "Request body too large")
    try {
      await handler(req, res)
    } catch {
      // Never echo the error: it could contain request text. Only the status is reported.
      if (!res.headersSent) fail(res, 500, "Something went wrong.")
    }
  }
}
