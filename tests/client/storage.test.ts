import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"
import type { ChatMsg, DayLog } from "../../shared/types"
import { emptyGraph } from "../../src/lib/memory/graph"
import { createMemoryStorage, openStorage } from "../../src/lib/storage"
import type { Storage } from "../../src/lib/storage"

const msg = (n: number, c = 1): ChatMsg => ({
  id: `m_${n}_${c}`, role: c % 2 ? "user" : "assistant", content: `hello ${n}`, createdAt: new Date(n).toISOString(),
})
const log = (d: string): DayLog => ({ localDate: d, notes: [{ t: "10:00", text: "a note" }], coverage: { mood: "ok" }, summary: null, consolidatedAt: null })

const factories: [string, () => Promise<Storage>][] = [
  ["indexeddb", () => openStorage(new IDBFactory())],
  ["in-memory fallback", () => openStorage(null)],
]

describe.each(factories)("storage (%s)", (_name, open) => {
  it("uses the expected backend", async () => {
    const s = await open()
    expect(s.kind).toBe(_name === "indexeddb" ? "indexeddb" : "memory")
  })

  it("round-trips messages in chronological order", async () => {
    const s = await open()
    expect(await s.loadMessages()).toEqual([])
    await s.saveMessage(msg(3))
    await s.saveMessage(msg(1))
    await s.saveMessage(msg(2, 10))
    await s.saveMessage(msg(2, 9))
    expect((await s.loadMessages()).map((m) => m.id)).toEqual(["m_1_1", "m_2_9", "m_2_10", "m_3_1"])
    await s.replaceMessages([msg(5)])
    expect((await s.loadMessages()).map((m) => m.id)).toEqual(["m_5_1"])
  })

  it("round-trips the graph and returns null when absent", async () => {
    const s = await open()
    expect(await s.loadGraph()).toBeNull()
    const g = emptyGraph(new Date("2026-03-10T10:00:00Z"))
    await s.saveGraph(g)
    expect(await s.loadGraph()).toEqual(g)
  })

  it("keeps only the newest 30 snapshots", async () => {
    const s = await open()
    for (let i = 0; i < 35; i++) await s.addSnapshot({ at: `t${i}`, reason: `r${i}`, graph: emptyGraph() })
    const snaps = await s.listSnapshots()
    expect(snaps).toHaveLength(30)
    expect(snaps[0].reason).toBe("r5")
    expect(snaps[29].reason).toBe("r34")
  })

  it("round-trips day logs, replaces them and stores settings", async () => {
    const s = await open()
    await s.saveDayLog(log("2026-03-10"))
    await s.saveDayLog({ ...log("2026-03-09"), summary: "x" })
    await s.saveDayLog({ ...log("2026-03-10"), summary: "updated" })
    const logs = await s.loadDayLogs()
    expect(logs.map((l) => l.localDate)).toEqual(["2026-03-09", "2026-03-10"])
    expect(logs[1].summary).toBe("updated")
    await s.replaceDayLogs([log("2026-04-01")])
    expect((await s.loadDayLogs()).map((l) => l.localDate)).toEqual(["2026-04-01"])

    expect(await s.getSetting("aiName")).toBeNull()
    await s.setSetting("aiName", "Robin")
    await s.setSetting("lastSavedAt", "2026-03-10T10:00:00Z")
    expect(await s.getSetting("aiName")).toBe("Robin")
    await s.setSetting("aiName", null)
    expect(await s.getSetting("aiName")).toBeNull()
    expect(await s.getSetting("lastSavedAt")).toBe("2026-03-10T10:00:00Z")
  })

  it("clearAll empties every store", async () => {
    const s = await open()
    await s.saveMessage(msg(1))
    await s.saveGraph(emptyGraph())
    await s.saveDayLog(log("2026-03-10"))
    await s.addSnapshot({ at: "t", reason: "r", graph: emptyGraph() })
    await s.setSetting("aiName", "Robin")
    await s.clearAll()
    expect(await s.loadMessages()).toEqual([])
    expect(await s.loadGraph()).toBeNull()
    expect(await s.loadDayLogs()).toEqual([])
    expect(await s.listSnapshots()).toEqual([])
    expect(await s.getSetting("aiName")).toBeNull()
  })
})

describe("indexeddb persistence and corrupt data", () => {
  it("data survives re-opening the same database", async () => {
    const factory = new IDBFactory()
    const a = await openStorage(factory)
    await a.saveMessage(msg(1))
    const b = await openStorage(factory)
    expect((await b.loadMessages()).map((m) => m.id)).toEqual(["m_1_1"])
  })

  it("resets a store that holds corrupt data instead of throwing", async () => {
    const factory = new IDBFactory()
    const s = await openStorage(factory)
    await s.saveMessage(msg(1))
    await s.saveGraph(emptyGraph())
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("zeneb-lite", 1)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(["graph", "messages"], "readwrite")
        tx.objectStore("graph").put({ nodes: "broken" }, "main")
        tx.objectStore("messages").put({ id: "bad" })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
    expect(await s.loadGraph()).toBeNull()
    expect(await s.loadMessages()).toEqual([])
    await s.saveMessage(msg(2))
    expect((await s.loadMessages()).map((m) => m.id)).toEqual(["m_2_1"])
  })

  it("createMemoryStorage returns independent instances", async () => {
    const a = createMemoryStorage()
    const b = createMemoryStorage()
    await a.saveMessage(msg(1))
    expect(await b.loadMessages()).toEqual([])
  })
})
