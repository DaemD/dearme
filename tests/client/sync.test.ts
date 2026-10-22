import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMsg, DayLog, SyncState } from "../../shared/types"
import { api, ApiRequestError } from "../../src/lib/api"
import { emptyGraph, applyDiff } from "../../src/lib/memory/graph"
import { setUnauthorizedHandler } from "../../src/lib/session"
import { __resetSharedStorage, getStorage } from "../../src/lib/storage"
import { __flushBackup, __resetSync, isBackupDisabled, restoreIfEmpty, scheduleBackup } from "../../src/lib/sync"
import { installFetch, silenceConsole } from "./helpers"

const NOW = new Date("2026-03-10T10:00:00Z")
const msg = (n: number): ChatMsg => ({ id: `m_${n}_1`, role: "user", content: `hello ${n}`, createdAt: new Date(NOW.getTime() + n * 1000).toISOString() })
const dayLog = (i: number): DayLog => ({ localDate: `2026-01-${String(i + 1).padStart(2, "0")}`, notes: [], coverage: {}, summary: null, consolidatedAt: null })

beforeEach(() => {
  silenceConsole()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetSharedStorage()
  __resetSync()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function seedLocal(messageCount: number, logCount = 0) {
  const s = await getStorage()
  const graph = applyDiff(emptyGraph(NOW), { ops: [{ op: "add_fact", source: "zeneb", target: { name: "Town", type: "place" }, type: "LIVES_IN", text: "Lives in Town", source_kind: "said", confidence: 0.9 }] }, { reason: "t", now: NOW }).graph
  await s.saveGraph(graph)
  await s.replaceMessages(Array.from({ length: messageCount }, (_, i) => msg(i)))
  await s.replaceDayLogs(Array.from({ length: logCount }, (_, i) => dayLog(i)))
  await s.setSetting("aiName", "Robin")
  return graph
}

describe("scheduleBackup", () => {
  it("debounces: many calls inside 2 s make one PUT carrying graph, messages, day logs and aiName", async () => {
    const graph = await seedLocal(5, 2)
    const net = installFetch({ "PUT /api/sync": () => ({ body: { savedAt: "x" } }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(1000)
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(1999)
    expect(net.count("PUT /api/sync")).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(1)
    const body = net.of("PUT /api/sync")[0].body as SyncState
    expect(body.graph).toEqual(graph)
    expect(body.messages).toHaveLength(5)
    expect(body.dayLogs).toHaveLength(2)
    expect(body.aiName).toBe("Robin")
    expect(Number.isNaN(Date.parse(body.savedAt))).toBe(false)
    expect(await (await getStorage()).getSetting("lastSyncedAt")).not.toBeNull()
  })

  it("sends only the newest 300 messages and 30 day logs", async () => {
    await seedLocal(350, 35)
    const net = installFetch({ "PUT /api/sync": () => ({ body: {} }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    const body = net.of("PUT /api/sync")[0].body as SyncState
    expect(body.messages).toHaveLength(300)
    expect(body.messages[299].id).toBe("m_349_1")
    expect(body.messages[0].id).toBe("m_50_1")
    expect(body.dayLogs).toHaveLength(30)
    expect(body.dayLogs[29].localDate).toBe(dayLog(34).localDate)
  })

  it("retries once with half the messages on 413", async () => {
    await seedLocal(100)
    let n = 0
    const net = installFetch({ "PUT /api/sync": () => (++n === 1 ? { status: 413, body: { detail: "too large" } } : { body: {} }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    const puts = net.of("PUT /api/sync")
    expect(puts).toHaveLength(2)
    expect((puts[0].body as SyncState).messages).toHaveLength(100)
    const second = puts[1].body as SyncState
    expect(second.messages).toHaveLength(50)
    expect(second.messages[49].id).toBe("m_99_1") // the newest half
  })

  it("gives up quietly after a second 413 (no third attempt)", async () => {
    await seedLocal(10)
    const net = installFetch({ "PUT /api/sync": () => ({ status: 413, body: { detail: "too large" } }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(2)
  })

  it("ignores 503 silently and stops retrying for the session", async () => {
    await seedLocal(3)
    const net = installFetch({ "PUT /api/sync": () => ({ status: 503, body: { detail: "not configured" } }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(1)
    expect(isBackupDisabled()).toBe(true)
    expect(console.warn).not.toHaveBeenCalled()
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(5000)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(1)
  })

  it("never throws on network errors or server errors", async () => {
    await seedLocal(3)
    installFetch({ "PUT /api/sync": () => ({ networkError: true }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(__flushBackup()).resolves.toBeUndefined()
    installFetch({ "PUT /api/sync": () => ({ status: 500 }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(__flushBackup()).resolves.toBeUndefined()
    expect(isBackupDisabled()).toBe(false)
  })

  it("does nothing when there is no graph yet", async () => {
    const net = installFetch({ "PUT /api/sync": () => ({ body: {} }) })
    scheduleBackup()
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(0)
  })
})

describe("restoreIfEmpty", () => {
  const remote = (): SyncState => {
    const graph = applyDiff(emptyGraph(NOW), { ops: [{ op: "add_fact", source: "zeneb", target: { name: "Hill", type: "place" }, type: "LIVES_NEAR", text: "Lives near Hill", source_kind: "said", confidence: 0.9 }] }, { reason: "t", now: NOW }).graph
    return { graph, messages: [msg(1), msg(2)], dayLogs: [dayLog(1)], aiName: "Sam", savedAt: "2026-03-09T10:00:00Z" }
  }

  it("loads the server backup into an empty browser", async () => {
    const state = remote()
    const net = installFetch({ "GET /api/sync": () => ({ body: { state } }) })
    expect(await restoreIfEmpty()).toBe(true)
    expect(net.count("GET /api/sync")).toBe(1)
    const s = await getStorage()
    expect((await s.loadMessages()).map((m) => m.id)).toEqual(["m_1_1", "m_2_1"])
    expect(await s.loadGraph()).toEqual(state.graph)
    expect((await s.loadDayLogs()).length).toBe(1)
    expect(await s.getSetting("aiName")).toBe("Sam")
  })

  it("does not touch the server when local data exists", async () => {
    await seedLocal(1)
    const net = installFetch({ "GET /api/sync": () => ({ body: { state: remote() } }) })
    expect(await restoreIfEmpty()).toBe(false)
    expect(net.count("GET /api/sync")).toBe(0)
  })

  it("restores when the local graph has only the hub and no messages", async () => {
    await (await getStorage()).saveGraph(emptyGraph(NOW))
    installFetch({ "GET /api/sync": () => ({ body: { state: remote() } }) })
    expect(await restoreIfEmpty()).toBe(true)
  })

  it("returns false and changes nothing for state null, 503, network errors and junk", async () => {
    for (const reply of [{ body: { state: null } }, { status: 503, body: { detail: "off" } }, { networkError: true }, { body: { state: { graph: 5 } } }]) {
      installFetch({ "GET /api/sync": () => reply })
      expect(await restoreIfEmpty()).toBe(false)
    }
    expect(await (await getStorage()).loadMessages()).toEqual([])
  })
})

describe("api wrapper", () => {
  afterEach(() => setUnauthorizedHandler(() => undefined))

  it("sends the bearer token and JSON, and parses the response", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "tok123", setItem: () => undefined, removeItem: () => undefined })
    const net = installFetch({ "POST /api/chat": () => ({ body: { reply: "hi" } }) })
    const res = await api.chat({ history: [{ role: "user", content: "yo" }], aiName: null, memory: "" })
    expect(res.reply).toBe("hi")
    expect(net.calls[0].headers.Authorization).toBe("Bearer tok123")
    expect(net.calls[0].headers["Content-Type"]).toBe("application/json")
  })

  it("on 401 clears the session via handleUnauthorized and throws", async () => {
    const removed = vi.fn()
    vi.stubGlobal("localStorage", { getItem: () => "tok", setItem: () => undefined, removeItem: removed })
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    installFetch({ "GET /api/seed": () => ({ status: 401, body: { detail: "nope" } }) })
    await expect(api.seed()).rejects.toMatchObject({ status: 401 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalled()
  })

  it("maps failures to the server detail, or a friendly default", async () => {
    installFetch({
      "POST /api/chat": () => ({ status: 400, body: { detail: "Message too long" } }),
      "GET /api/seed": () => ({ status: 500, body: "not an object" }),
    })
    await expect(api.chat({ history: [], aiName: null, memory: "" })).rejects.toThrow("Message too long")
    await expect(api.seed()).rejects.toThrow(/Something went wrong/)
  })

  it("maps a network failure to the standard message", async () => {
    installFetch({ "GET /api/seed": () => ({ networkError: true }) })
    const err = await api.seed().catch((e) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err.message).toBe("Can't reach the server. Check your connection and try again.")
    expect(err.status).toBe(0)
  })
})
