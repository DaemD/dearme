// Local stand-in for Vercel: serves /api/<name> from api/<name>.ts on port 3001 (Vite proxies /api here).
// Run with: tsx dev-server.ts
import { existsSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Tiny .env parser: KEY=value lines, optional quotes, # comments. Values are never printed.
for (const name of [".env.local", ".env"]) {
  const file = join(process.cwd(), name)
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith("#")) continue
    let value = m[2]
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = value // .env.local wins over .env
  }
}

type Handler = (req: unknown, res: unknown) => Promise<void> | void

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function shimResponse(res: ServerResponse) {
  const r = res as ServerResponse & Record<string, unknown>
  r.status = (code: number) => {
    res.statusCode = code
    return r
  }
  r.json = (data: unknown) => {
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify(data))
    return r
  }
  r.send = (data: unknown) => (typeof data === "object" && data !== null && !Buffer.isBuffer(data) ? (r.json as (d: unknown) => unknown)(data) : res.end(data as string | Buffer))
  return r
}

createServer(async (req, res) => {
  const out = shimResponse(res)
  const url = new URL(req.url ?? "/", "http://localhost")
  const name = /^\/api\/([a-z]+)\/?$/.exec(url.pathname)?.[1]
  const file = name ? join(process.cwd(), "api", `${name}.ts`) : ""
  if (!name || !existsSync(file)) {
    res.statusCode = 404
    res.setHeader("Content-Type", "application/json")
    return void res.end(JSON.stringify({ detail: "Not Found" }))
  }

  // Shim the parts of VercelRequest the handlers use.
  const raw = await readBody(req)
  const shim = req as IncomingMessage & { body?: unknown; query?: Record<string, string> }
  shim.query = Object.fromEntries(url.searchParams)
  if (raw.length) {
    try {
      shim.body = JSON.parse(raw.toString("utf8"))
    } catch {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      return void res.end(JSON.stringify({ detail: "Invalid JSON" }))
    }
  }

  try {
    const mod = (await import(pathToFileURL(file).href)) as { default: Handler }
    await mod.default(shim, out)
  } catch (err) {
    console.error(`/api/${name} crashed:`, err instanceof Error ? err.name : "error")
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader("Content-Type", "application/json")
    }
    res.end(JSON.stringify({ detail: "Something went wrong." }))
  }
}).listen(3001, () => console.log("API dev server on http://localhost:3001"))
