import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import admin from "../../api/admin"
import chat from "../../api/chat"
import consolidate from "../../api/consolidate"
import extract from "../../api/extract"
import health from "../../api/health"
import login from "../../api/login"
import seed from "../../api/seed"
import sync from "../../api/sync"
import { PERSONA_TEMPLATE } from "../../api/_lib/persona"
import { call, enableRedis, installFetch, useEnv, validToken } from "./helpers"

useEnv()

describe("health", () => {
  it("answers without auth", async () => {
    const res = await call(health)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: "running" })
  })
})

describe("common behaviour", () => {
  const endpoints: [string, any, string][] = [
    ["health", health, "GET"], ["login", login, "POST"], ["chat", chat, "POST"], ["extract", extract, "POST"],
    ["consolidate", consolidate, "POST"], ["seed", seed, "GET"], ["sync", sync, "GET"], ["admin", admin, "GET"],
  ]
  for (const [name, handler, method] of endpoints) {
    it(`${name}: Cache-Control no-store on success, auth failure and 405`, async () => {
      enableRedis()
      installFetch()
      const ok = await call(handler, { method, token: validToken(), body: {}, headers: { "X-Admin-Key": "nope" } })
      const wrong = await call(handler, { method: "DELETE" })
      expect(ok.headers["cache-control"]).toBe("no-store")
      expect(wrong.headers["cache-control"]).toBe("no-store")
      expect(wrong.statusCode).toBe(405)
      expect(wrong.headers.allow).toContain(method)
    })
  }
  it("rejects bodies over 1_000_000 bytes with 413, before auth work", async () => {
    const big = { password: "x".repeat(1_000_001) }
    const res = await call(login, { method: "POST", body: big })
    expect(res.statusCode).toBe(413)
    const res2 = await call(chat, { method: "POST", token: validToken(), body: { history: [], memory: "x".repeat(1_000_001) } })
    expect(res2.statusCode).toBe(413)
    const res3 = await call(sync, { method: "PUT", token: validToken(), headers: { "content-length": "2000000" }, body: {} })
    expect(res3.statusCode).toBe(413)
  })
  it("errors are always { detail: string }", async () => {
    const res = await call(chat, { method: "POST", token: validToken(), body: {} })
    expect(Object.keys(res.body as object)).toEqual(["detail"])
  })
})

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === "node_modules") continue
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|css|html|json|js|svg)$/.test(name)) yield p
  }
}

describe("public bundle stays clean", () => {
  const root = process.cwd()
  const publicFiles = [...files(join(root, "src")), ...files(join(root, "shared")), join(root, "index.html")]

  it("scans a non-trivial set of files", () => {
    expect(publicFiles.length).toBeGreaterThan(1)
  })
  it("no 40-character slice of the persona template appears in src/, shared/ or index.html", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ")
    const persona = flat(PERSONA_TEMPLATE)
    const windows = new Set<string>()
    for (let i = 0; i + 40 <= persona.length; i++) windows.add(persona.slice(i, i + 40))
    for (const f of publicFiles) {
      const text = flat(readFileSync(f, "utf8"))
      for (const w of windows) {
        if (text.includes(w)) throw new Error(`persona text found in ${f}`)
      }
    }
  })
  it("nothing in the public files references api/_data or the server-only modules", () => {
    for (const f of publicFiles) {
      const text = readFileSync(f, "utf8")
      expect(text, f).not.toMatch(/_data\/|seed\.json|SEED_OPS_JSON/)
      expect(text, f).not.toMatch(/api\/_lib|_lib\/(persona|seed)/)
    }
  })
})
