import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import admin from "../../api/admin"
import seed from "../../api/seed"
import sync from "../../api/sync"
import type { Op, SyncState } from "../../shared/types"
import { ADMIN_KEY, call, enableRedis, installFetch, setEnv, useEnv, validToken } from "./helpers"

useEnv()

// A neutral fixture: fake names only. The real starting facts live outside the code.
const FIXTURE: Op[] = [
  { op: "add_node", type: "organisation", name: "Example University", aliases: ["EU"] },
  { op: "add_node", type: "person", name: "Family", aliases: ["mum", "dad"], sensitivity: "sensitive" },
  { op: "add_fact", source: "zeneb", target: { name: "Example University", type: "organisation" }, type: "STUDIES_AT", text: "Alex studies at Example University", source_kind: "said", confidence: 1 },
  { op: "add_fact", source: "zeneb", target: { name: "Family", type: "person" }, type: "FAMILY_RELATIONSHIP", text: "Alex has a complicated family situation", source_kind: "said", confidence: 1, sensitivity: "sensitive" },
]
const getSeed = () => call(seed, { token: validToken() })

describe("seed", () => {
  // Never read or write the real api/_data/seed.json: every test points SEED_FILE at a temp path.
  beforeEach(() => setEnv({ SEED_FILE: join(mkdtempSync(join(tmpdir(), "seed-test-")), "none.json") }))
  it("is empty when nothing is configured", async () => {
    const res = await getSeed()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ops: [] })
  })
  it("returns the ops from SEED_OPS_JSON", async () => {
    setEnv({ SEED_OPS_JSON: JSON.stringify(FIXTURE) })
    const res = await getSeed()
    expect(res.body).toEqual({ ops: FIXTURE })
  })
  it("fixture has the expected shape: sensitive Family, no duplicate nodes, valid op fields", async () => {
    setEnv({ SEED_OPS_JSON: JSON.stringify(FIXTURE) })
    const ops = ((await getSeed()).body as { ops: Op[] }).ops
    const nodes = ops.filter((o) => o.op === "add_node") as Extract<Op, { op: "add_node" }>[]
    expect(new Set(nodes.map((n) => n.name.toLowerCase())).size).toBe(nodes.length)
    expect(nodes.find((n) => n.name === "Family")?.sensitivity).toBe("sensitive")
    for (const o of ops) {
      if (o.op === "add_fact") {
        expect(o.source_kind).toBe("said")
        expect(o.confidence).toBe(1)
        expect(typeof o.text).toBe("string")
      }
    }
    expect(nodes.findIndex((n) => n.name === "Family")).toBeLessThan(ops.findIndex((o) => o.op === "add_fact"))
  })
  it("bad JSON, non-arrays, non-object entries and ops without a string op give an empty list", async () => {
    for (const raw of ["{not json", "{}", '"x"', "[1,2]", "[null]", '[{"op":5}]', '[{"name":"x"}]', "[[]]"]) {
      setEnv({ SEED_OPS_JSON: raw })
      expect((await getSeed()).body).toEqual({ ops: [] })
    }
  })
  it("more than 200 ops gives an empty list; exactly 200 is fine", async () => {
    const op = { op: "add_node", type: "topic", name: "t" }
    setEnv({ SEED_OPS_JSON: JSON.stringify(Array(201).fill(op)) })
    expect((await getSeed()).body).toEqual({ ops: [] })
    setEnv({ SEED_OPS_JSON: JSON.stringify(Array(200).fill(op)) })
    expect(((await getSeed()).body as { ops: unknown[] }).ops).toHaveLength(200)
  })
  it("uses the seed file only when the env var is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-test-"))
    const file = join(dir, "seed.json")
    setEnv({ SEED_FILE: file })
    const fileOps = [{ op: "add_node", type: "topic", name: "From file" }]
    try {
      writeFileSync(file, JSON.stringify(fileOps))
      expect((await getSeed()).body).toEqual({ ops: fileOps })
      setEnv({ SEED_OPS_JSON: JSON.stringify(FIXTURE) })
      expect((await getSeed()).body).toEqual({ ops: FIXTURE })
      setEnv({ SEED_OPS_JSON: "{bad" }) // a set-but-invalid env var does not fall through to the file
      expect((await getSeed()).body).toEqual({ ops: [] })
      setEnv({ SEED_OPS_JSON: undefined })
      writeFileSync(file, "garbage")
      expect((await getSeed()).body).toEqual({ ops: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("returns empty when the data file does not exist", async () => {
    expect((await getSeed()).body).toEqual({ ops: [] })
  })
})

const state = (over: Partial<SyncState> = {}): SyncState => ({
  graph: { version: 1, updated_at: "2026-10-21T10:00:00.000Z", nodes: { zeneb: { id: "zeneb" } as never }, edges: {} },
  messages: [{ id: "m_1", role: "user", content: "hello", createdAt: "2026-10-21T10:00:00.000Z" }],
  dayLogs: [], aiName: "Mira", savedAt: "2026-10-21T10:00:01.000Z", ...over,
})
const put = (body: unknown) => call(sync, { method: "PUT", body, token: validToken() })
const getState = () => call(sync, { method: "GET", token: validToken() })

describe("sync", () => {
  it("round-trips through Redis as one JSON string at zeneb:state", async () => {
    enableRedis()
    const fake = installFetch()
    expect((await getState()).body).toEqual({ state: null })
    const res = await put(state())
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ savedAt: "2026-10-21T10:00:01.000Z" })
    expect(JSON.parse(fake.redis.get("zeneb:state")!)).toEqual(state())
    expect((await getState()).body).toEqual({ state: state() })
    const set = fake.calls.find((c) => c.json?.[0] === "SET")!
    expect((set.init.headers as Record<string, string>).Authorization).toBe("Bearer redis-token")
    expect(set.url).toBe("https://redis.test")
  })
  it("accepts UPSTASH_* env names too", async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "t" })
    installFetch()
    expect((await put(state())).statusCode).toBe(200)
  })
  it("drops unknown top-level fields", async () => {
    enableRedis()
    const fake = installFetch()
    await put({ ...state(), extra: "junk" })
    expect(JSON.parse(fake.redis.get("zeneb:state")!).extra).toBeUndefined()
  })
  it("413 over 900_000 bytes, nothing stored", async () => {
    enableRedis()
    const fake = installFetch()
    const res = await put(state({ aiName: "x".repeat(900_001) }))
    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({ detail: "Backup is too large" })
    expect(fake.redis.has("zeneb:state")).toBe(false)
    expect((await put(state({ aiName: "x".repeat(850_000) }))).statusCode).toBe(200)
  })
  it("503 without Redis", async () => {
    installFetch()
    for (const r of [await put(state()), await getState()]) {
      expect(r.statusCode).toBe(503)
      expect(r.body).toEqual({ detail: "Backup storage is not set up" })
    }
  })
  it("400 for invalid shapes", async () => {
    enableRedis()
    installFetch()
    const bad: unknown[] = [
      undefined, [], "x", { ...state(), graph: null }, { ...state(), graph: { nodes: {}, edges: [] } },
      { ...state(), graph: { nodes: [], edges: {} } }, state({ messages: Array(301).fill({}) }), { ...state(), messages: {} },
      state({ dayLogs: Array(31).fill({}) }), { ...state(), aiName: 5 }, { ...state(), savedAt: 5 }, { ...state(), savedAt: undefined },
    ]
    for (const b of bad) expect((await put(b)).statusCode).toBe(400)
    expect((await put(state({ messages: Array(300).fill({}), dayLogs: Array(30).fill({}), aiName: null }))).statusCode).toBe(200)
  })
  it("502 when Redis is down, without leaking the token", async () => {
    enableRedis()
    const fake = installFetch()
    fake.redisDown = true
    const res = await put(state())
    expect(res.statusCode).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain("redis-token")
  })
  it("405 for POST", async () => {
    const res = await call(sync, { method: "POST", token: validToken() })
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe("GET, PUT")
  })
})

const getAdmin = (headers: Record<string, string> | undefined, query: Record<string, string> = {}, ip?: string) =>
  call(admin, { method: "GET", headers, query, ip })
const NOT_FOUND = { detail: "Not Found" }

describe("admin", () => {
  it("404 for a missing, wrong, short or unset key", async () => {
    setEnv({ ADMIN_KEY })
    enableRedis()
    installFetch()
    expect((await getAdmin(undefined)).body).toEqual(NOT_FOUND)
    expect((await getAdmin({ "X-Admin-Key": "wrong-wrong-wrong-wrong" })).statusCode).toBe(404)
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY.slice(0, 15) })).statusCode).toBe(404)
    setEnv({ ADMIN_KEY: undefined })
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY })).statusCode).toBe(404)
    expect((await getAdmin({ "X-Admin-Key": "" })).statusCode).toBe(404)
    setEnv({ ADMIN_KEY: "short" })
    expect((await getAdmin({ "X-Admin-Key": "short" })).statusCode).toBe(404)
  })
  it("a normal user token does not open it", async () => {
    setEnv({ ADMIN_KEY })
    const res = await call(admin, { token: validToken() })
    expect(res.statusCode).toBe(404)
  })
  it("locks out a guesser, who then gets 404 even with the right key", async () => {
    setEnv({ ADMIN_KEY })
    enableRedis()
    installFetch()
    for (let i = 0; i < 5; i++) expect((await getAdmin({ "X-Admin-Key": `guess-guess-guess-${i}` })).statusCode).toBe(404)
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY })).statusCode).toBe(404)
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY }, {}, "other-client")).statusCode).toBe(200) // others unaffected
  })
  it("admin failures do not lock the login of the same client", async () => {
    setEnv({ ADMIN_KEY })
    for (let i = 0; i < 6; i++) await getAdmin({ "X-Admin-Key": "wrong-wrong-wrong-wrong" })
    const login = (await import("../../api/login")).default
    const res = await call(login, { method: "POST", body: { password: "correct horse battery staple" } })
    expect(res.statusCode).toBe(200)
  })
  it("returns the stored graph by default and the full state for what=state", async () => {
    setEnv({ ADMIN_KEY })
    enableRedis()
    const fake = installFetch()
    fake.redis.set("zeneb:state", JSON.stringify(state()))
    const g = await getAdmin({ "X-Admin-Key": ADMIN_KEY })
    expect(g.statusCode).toBe(200)
    expect(g.body).toEqual(state().graph)
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY }, { what: "graph" })).body).toEqual(state().graph)
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY }, { what: "state" })).body).toEqual(state())
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY }, { what: "bogus" })).statusCode).toBe(400)
  })
  it("falls back to the empty hub-only graph", async () => {
    setEnv({ ADMIN_KEY })
    enableRedis()
    installFetch()
    const g = (await getAdmin({ "X-Admin-Key": ADMIN_KEY })).body as { version: number; updated_at: string; nodes: Record<string, { id: string }>; edges: object }
    expect(g.version).toBe(1)
    expect(typeof g.updated_at).toBe("string")
    expect(Object.keys(g.nodes)).toEqual(["zeneb"])
    expect(g.nodes.zeneb.id).toBe("zeneb")
    expect(g.edges).toEqual({})
  })
  it("download=1 adds a Content-Disposition attachment", async () => {
    setEnv({ ADMIN_KEY })
    enableRedis()
    installFetch()
    const h = { "X-Admin-Key": ADMIN_KEY }
    expect((await getAdmin(h, { download: "1" })).headers["content-disposition"]).toBe('attachment; filename="graph.json"')
    expect((await getAdmin(h, { what: "state", download: "1" })).headers["content-disposition"]).toBe('attachment; filename="state.json"')
    expect((await getAdmin(h)).headers["content-disposition"]).toBeUndefined()
  })
  it("503 only when storage is missing and the key was valid", async () => {
    setEnv({ ADMIN_KEY })
    installFetch()
    expect((await getAdmin({ "X-Admin-Key": ADMIN_KEY })).statusCode).toBe(503)
    expect((await getAdmin({ "X-Admin-Key": "wrong-wrong-wrong-wrong" })).statusCode).toBe(404)
  })
})
