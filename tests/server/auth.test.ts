import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { signToken, verifyToken } from "../../api/_lib/auth"
import login from "../../api/login"
import chat from "../../api/chat"
import extract from "../../api/extract"
import consolidate from "../../api/consolidate"
import seed from "../../api/seed"
import sync from "../../api/sync"
import { ADMIN_KEY, PASSWORD, SECRET, call, enableRedis, installFetch, setEnv, useEnv, validToken } from "./helpers"

useEnv()

const doLogin = (password: string, headers: Record<string, string> = {}, ip?: string) =>
  call(login, { method: "POST", body: { password }, headers, ip })

describe("token", () => {
  it("signs and verifies", () => {
    expect(verifyToken(signToken())).toBe(true)
    expect(signToken().split(".")).toHaveLength(2)
  })
  it("expires after 30 days", () => {
    const now = Date.now()
    const t = signToken(now)
    expect(verifyToken(t, now + 29 * 86400_000)).toBe(true)
    expect(verifyToken(t, now + 31 * 86400_000)).toBe(false)
  })
  it("rejects tampered and malformed tokens", () => {
    const [p, s] = signToken().split(".")
    const forged = Buffer.from(JSON.stringify({ sub: "zeneb", exp: 9999999999 })).toString("base64url")
    for (const bad of ["", "abc", `${p}.`, `.${s}`, `${p}.${s}x`, `${forged}.${s}`, `${p}.${s}.${s}`, `${p}.${"A".repeat(43)}`]) {
      expect(verifyToken(bad)).toBe(false)
    }
  })
  it("rejects a token signed with another secret or for another subject", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "zeneb", exp: Math.floor(Date.now() / 1000) + 100 })).toString("base64url")
    const sig = (secret: string, p: string) => createHmac("sha256", secret).update(p).digest("base64url")
    expect(verifyToken(`${payload}.${sig(SECRET, payload)}`)).toBe(true)
    expect(verifyToken(`${payload}.${sig("another-secret-0123456789", payload)}`)).toBe(false)
    const other = Buffer.from(JSON.stringify({ sub: "mallory", exp: Math.floor(Date.now() / 1000) + 100 })).toString("base64url")
    expect(verifyToken(`${other}.${sig(SECRET, other)}`)).toBe(false)
  })
  it("refuses to work with a missing or short SECRET_KEY", async () => {
    const t = signToken()
    setEnv({ SECRET_KEY: "short" })
    expect(verifyToken(t)).toBe(false)
    expect(() => signToken()).toThrow()
    setEnv({ SECRET_KEY: undefined })
    expect(verifyToken(t)).toBe(false)
    const res = await doLogin(PASSWORD)
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain("SECRET")
    const prot = await call(seed, { token: t })
    expect(prot.statusCode).toBe(500)
  })
})

describe("login", () => {
  it("succeeds with the right password", async () => {
    const res = await doLogin(PASSWORD)
    expect(res.statusCode).toBe(200)
    const body = res.body as { token: string; user: { username: string } }
    expect(body.user).toEqual({ username: "zeneb" })
    expect(verifyToken(body.token)).toBe(true)
  })
  it("401 on a wrong, empty or non-string password", async () => {
    for (const pw of ["nope", "", PASSWORD + " "]) {
      const res = await doLogin(pw)
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual({ detail: "Incorrect password" })
    }
    const res = await call(login, { method: "POST", body: { password: 5 } })
    expect(res.statusCode).toBe(401)
  })
  it("503 when ACCESS_PASSWORD is unset or empty (fail closed)", async () => {
    setEnv({ ACCESS_PASSWORD: undefined })
    const a = await doLogin("anything")
    expect(a.statusCode).toBe(503)
    expect(a.body).toEqual({ detail: "Login is not set up yet." })
    setEnv({ ACCESS_PASSWORD: "" })
    expect((await doLogin("")).statusCode).toBe(503)
  })
  it("locks out after 5 failures, even for the right password, with Retry-After", async () => {
    for (let i = 0; i < 5; i++) expect((await doLogin("wrong")).statusCode).toBe(401)
    const res = await doLogin(PASSWORD)
    expect(res.statusCode).toBe(429)
    expect((res.body as { detail: string }).detail).toMatch(/^Too many attempts\. Try again in \d+ minutes\.$/)
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0)
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(900)
  })
  it("a success resets that client's counter", async () => {
    for (let i = 0; i < 4; i++) await doLogin("wrong")
    expect((await doLogin(PASSWORD)).statusCode).toBe(200)
    for (let i = 0; i < 4; i++) expect((await doLogin("wrong")).statusCode).toBe(401)
  })
  it("unlocks after the 15 minute window", async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 5; i++) await doLogin("wrong")
    expect((await doLogin(PASSWORD)).statusCode).toBe(429)
    vi.advanceTimersByTime(15 * 60_000 + 1000)
    expect((await doLogin(PASSWORD)).statusCode).toBe(200)
  })
  it("clients are independent until the overall cap of 30", async () => {
    for (let i = 0; i < 5; i++) await doLogin("wrong", {}, "1.1.1.1")
    expect((await doLogin(PASSWORD, {}, "1.1.1.1")).statusCode).toBe(429)
    expect((await doLogin(PASSWORD, {}, "2.2.2.2")).statusCode).toBe(200)
    for (let i = 0; i < 30; i++) await doLogin("wrong", {}, `9.9.9.${i}`)
    expect((await doLogin(PASSWORD, {}, "brand-new")).statusCode).toBe(429)
  })
  it("uses the right-most X-Forwarded-For entry by default", async () => {
    for (let i = 0; i < 5; i++) await doLogin("wrong", { "X-Forwarded-For": `6.6.6.${i}, 203.0.113.7` })
    // same proxy-added address, different spoofed left side: still locked
    expect((await doLogin(PASSWORD, { "X-Forwarded-For": "6.6.6.99, 203.0.113.7" })).statusCode).toBe(429)
    expect((await doLogin(PASSWORD, { "X-Forwarded-For": "6.6.6.1, 198.51.100.9" })).statusCode).toBe(200)
  })
  it("ignores X-Forwarded-For when TRUST_PROXY_HEADERS=false", async () => {
    setEnv({ TRUST_PROXY_HEADERS: "false" })
    for (let i = 0; i < 5; i++) await doLogin("wrong", { "X-Forwarded-For": `9.9.9.${i}` }, "5.5.5.5")
    expect((await doLogin(PASSWORD, { "X-Forwarded-For": "1.2.3.4" }, "5.5.5.5")).statusCode).toBe(429)
  })
  it("keeps failure counters in Redis when configured (shared across instances)", async () => {
    enableRedis()
    const fake = installFetch()
    for (let i = 0; i < 5; i++) await doLogin("wrong")
    expect([...fake.redis.keys()].some((k) => k.startsWith("zeneb:fail:login"))).toBe(true)
    expect((await doLogin(PASSWORD)).statusCode).toBe(429)
    expect(JSON.stringify(fake.calls.map((c) => c.json))).not.toContain(PASSWORD)
  })
  it("405 with Allow for other methods", async () => {
    const res = await call(login, { method: "GET" })
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe("POST")
  })
})

describe("protected endpoints", () => {
  const cases: [string, any, string][] = [
    ["chat", chat, "POST"], ["extract", extract, "POST"], ["consolidate", consolidate, "POST"],
    ["seed", seed, "GET"], ["sync GET", sync, "GET"], ["sync PUT", sync, "PUT"],
  ]
  for (const [name, handler, method] of cases) {
    it(`${name}: 401 without a token, with a bad token and with a tampered token`, async () => {
      const [p, s] = validToken().split(".")
      const variants: Record<string, string>[] = [{}, { Authorization: "Bearer nonsense" }, { Authorization: `Bearer ${p}.${s}A` }, { Authorization: validToken() }, { Authorization: "Basic abc" }]
      for (const headers of variants) {
        const res = await call(handler, { method, headers, body: {} })
        expect(res.statusCode).toBe(401)
        expect(res.body).toEqual({ detail: "Not authenticated" })
      }
    })
  }
  it("an admin key is not a user token", async () => {
    setEnv({ ADMIN_KEY })
    const res = await call(seed, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } })
    expect(res.statusCode).toBe(401)
  })
})
