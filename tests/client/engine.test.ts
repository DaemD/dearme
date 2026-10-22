import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMsg, DayLog, SyncState } from "../../shared/types"
import {
  EngineError, __flushBackground, __setClock, getAiName, getMessages, initEngine, resetLocalData, sendMessage,
  setAiName, subscribe, validateAiName,
} from "../../src/lib/engine"
import { applyDiff, emptyGraph } from "../../src/lib/memory/graph"
import { getStorage } from "../../src/lib/storage"
import { __flushBackup, __resetSync } from "../../src/lib/sync"
import { installFetch, silenceConsole } from "./helpers"
import type { RouteReply } from "./helpers"

const T0 = new Date("2026-03-10T10:00:00Z")

// Neutral fake seed: the real starting facts live on the server.
const SEED_OPS = [
  { op: "add_node", type: "pet", name: "Pip", aliases: ["cat"] },
  { op: "add_node", type: "person", name: "Family", sensitivity: "sensitive", aliases: ["mum", "dad"] },
  { op: "add_fact", source: "zeneb", target: "Pip", type: "HAS_PET", text: "Has a grey cat called Pip", source_kind: "said", confidence: 1 },
  { op: "add_fact", source: "zeneb", target: { name: "Riverside College", type: "organisation" }, type: "STUDIES_AT", text: "Studies at Riverside College", source_kind: "said", confidence: 1 },
  { op: "add_fact", source: "zeneb", target: "Family", type: "FAMILY_RELATIONSHIP", text: "Argues with relatives about inheritance paperwork", source_kind: "said", confidence: 1 },
]

type Extract = { notes?: string[]; coverage?: Record<string, string>; ops?: unknown[] }
interface Setup {
  extract?: (body: any) => Extract | RouteReply
  chat?: (body: any) => RouteReply | Promise<RouteReply>
  consolidate?: (body: any) => RouteReply
  seed?: () => RouteReply
  syncGet?: () => RouteReply
  syncPut?: () => RouteReply
}

function setup(o: Setup = {}) {
  let chatN = 0
  return installFetch({
    "GET /api/seed": () => o.seed?.() ?? { body: { ops: SEED_OPS } },
    "POST /api/chat": (c) => o.chat?.(c.body) ?? { body: { reply: `reply ${++chatN}` } },
    "POST /api/extract": (c) => {
      const r = o.extract?.(c.body) ?? {}
      return "status" in r || "networkError" in r ? (r as RouteReply) : { body: { notes: [], coverage: {}, ops: [], ...r } }
    },
    "POST /api/consolidate": (c) => o.consolidate?.(c.body) ?? { body: { summary: "A quiet day.", ops: [], coverage: {} } },
    "GET /api/sync": () => o.syncGet?.() ?? { body: { state: null } },
    "PUT /api/sync": () => o.syncPut?.() ?? { body: { savedAt: "x" } },
  })
}

const addFactOp = (target: string, type: string, text: string, extra: Record<string, unknown> = {}) => ({
  op: "add_fact", source: "zeneb", target, type, text, source_kind: "said", confidence: 0.9, ...extra,
})

async function graphFacts(): Promise<string[]> {
  const g = await (await getStorage()).loadGraph()
  return Object.values(g?.edges ?? {}).filter((e) => e.status === "active").map((e) => e.text)
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)

beforeEach(async () => {
  silenceConsole()
  unhandled.length = 0
  process.on("unhandledRejection", onUnhandled)
  __setClock(() => T0)
  setup()
  await resetLocalData()
})
afterEach(async () => {
  await __flushBackground()
  process.off("unhandledRejection", onUnhandled)
  __setClock(null)
  __resetSync()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("initEngine", () => {
  it("seeds an empty graph once, as reason 'seed', and is idempotent", async () => {
    const net = setup()
    await initEngine()
    await initEngine()
    await Promise.all([initEngine(), initEngine()])
    expect(net.count("GET /api/seed")).toBe(1)
    const facts = await graphFacts()
    expect(facts).toContain("Has a grey cat called Pip")
    expect(facts).toHaveLength(3)
    const snaps = await (await getStorage()).listSnapshots()
    expect(snaps.at(-1)?.reason).toBe("seed")
  })

  it("does not seed again on a later init once the graph has facts (loaded from storage)", async () => {
    setup()
    await initEngine()
    await resetLocalData() // clears everything, so rebuild the stored state by hand
    const s = await getStorage()
    const g = applyDiff(emptyGraph(T0), { ops: SEED_OPS }, { reason: "x", now: T0 }).graph
    await s.saveGraph(g)
    const net = setup()
    await initEngine()
    expect(net.count("GET /api/seed")).toBe(0)
  })

  it("continues with an empty graph when the seed fails and retries on the next init", async () => {
    let fail = true
    const net = setup({ seed: () => (fail ? { status: 502, body: { detail: "down" } } : { body: { ops: SEED_OPS } }) })
    await expect(initEngine()).resolves.toBeUndefined()
    expect(await graphFacts()).toEqual([])
    // chatting still works
    const { assistant } = await sendMessage("hello")
    expect(assistant.content).toBe("reply 1")
    fail = false
    await initEngine()
    expect(net.count("GET /api/seed")).toBe(3) // init, the init inside sendMessage, then this one
    expect(await graphFacts()).toHaveLength(3)
  })

  it("restores from the server backup before seeding when local is empty", async () => {
    const graph = applyDiff(emptyGraph(T0), { ops: [{ ...addFactOp("x", "LIVES_NEAR", "Lives near Hill"), target: { name: "Hill", type: "place" } }] }, { reason: "r", now: T0 }).graph
    const messages: ChatMsg[] = [
      { id: "m_1_1", role: "user", content: "earlier", createdAt: "2026-03-09T10:00:00Z" },
      { id: "m_1_2", role: "assistant", content: "earlier reply", createdAt: "2026-03-09T10:00:01Z" },
    ]
    const state: SyncState = { graph, messages, dayLogs: [], aiName: "Robin", savedAt: "2026-03-09T11:00:00Z" }
    const net = setup({ syncGet: () => ({ body: { state } }) })
    await initEngine()
    expect(net.count("GET /api/sync")).toBe(1)
    expect(net.count("GET /api/seed")).toBe(0)
    expect(getMessages().map((m) => m.content)).toEqual(["earlier", "earlier reply"])
    expect(getAiName()).toBe("Robin")
    expect(await graphFacts()).toEqual(["Lives near Hill"])
  })
})

describe("sendMessage", () => {
  it("rejects empty text without touching the network", async () => {
    const net = setup()
    await expect(sendMessage("   ")).rejects.toBeInstanceOf(EngineError)
    expect(net.count("POST /api/chat")).toBe(0)
    expect(getMessages()).toEqual([])
  })

  it("persists the user message before the chat request and returns both messages", async () => {
    let storedAtRequest: ChatMsg[] = []
    setup({
      chat: async () => {
        storedAtRequest = await (await getStorage()).loadMessages() // what is persisted at the moment of the call
        return { body: { reply: "Hello back" } }
      },
    })
    const stored = vi.fn()
    const s = await getStorage()
    const original = s.saveMessage.bind(s)
    s.saveMessage = async (m) => {
      stored(m.role)
      return original(m)
    }
    const { user, assistant } = await sendMessage("  Hello there  ")
    s.saveMessage = original
    expect(user).toMatchObject({ role: "user", content: "Hello there" })
    expect(user.id).toMatch(/^m_\d+_\d+$/)
    expect(assistant).toMatchObject({ role: "assistant", content: "Hello back" })
    expect(storedAtRequest.map((m) => m.role)).toEqual(["user"])
    expect(stored.mock.calls.map((c) => c[0])).toEqual(["user", "assistant"])
    expect((await s.loadMessages()).map((m) => m.content)).toEqual(["Hello there", "Hello back"])
    await __flushBackground()
  })

  it("keeps the user message and throws a user-safe EngineError on 502", async () => {
    setup({ chat: () => ({ status: 502, body: { detail: "upstream exploded: key sk-123" } }) })
    const err = await sendMessage("are you there").catch((e) => e)
    expect(err).toBeInstanceOf(EngineError)
    expect(err.message).toBe("The assistant is unavailable right now. Please try again.")
    expect(err.message).not.toMatch(/sk-/)
    expect(getMessages().map((m) => m.content)).toEqual(["are you there"])
    expect((await (await getStorage()).loadMessages()).map((m) => m.content)).toEqual(["are you there"])
  })

  it("uses the same safe message for unknown failures and a clear one for network loss", async () => {
    setup({ chat: () => ({ status: 500, body: "boom" }) })
    expect((await sendMessage("one").catch((e) => e)).message).toBe("The assistant is unavailable right now. Please try again.")
    setup({ chat: () => ({ networkError: true }) })
    expect((await sendMessage("two").catch((e) => e)).message).toBe("Can't reach the server. Check your connection and try again.")
    expect(getMessages()).toHaveLength(2)
  })

  it("sends at most 20 history items, ending with the new message, plus aiName", async () => {
    const net = setup()
    await setAiName("Robin")
    for (let i = 0; i < 13; i++) await sendMessage(`message ${i}`)
    await __flushBackground()
    const last = net.of("POST /api/chat").at(-1)!.body
    expect(last.history).toHaveLength(20)
    expect(last.history.at(-1)).toEqual({ role: "user", content: "message 12" })
    expect(last.history[0].role).toBe("assistant") // 25 messages before it: the window starts mid-conversation
    expect(last.aiName).toBe("Robin")
    expect(Object.keys(last.history[0])).toEqual(["role", "content"])
    const first = net.of("POST /api/chat")[0].body
    expect(first.history).toEqual([{ role: "user", content: "message 0" }])
  })

  it("sends the memory block with the seeded facts", async () => {
    const net = setup()
    await sendMessage("tell me about studying")
    await __flushBackground()
    const memory: string = net.of("POST /api/chat")[0].body.memory
    expect(memory.startsWith("WHAT YOU KNOW ABOUT ZENEB (private notes:")).toBe(true)
    expect(memory).toContain("- Has a grey cat called Pip")
    expect(memory).toContain("- Studies at Riverside College")
    expect(memory).toContain("NOT YET KNOWN ABOUT TODAY:")
  })

  it("notifies subscribers when messages change and supports unsubscribe", async () => {
    setup()
    const listener = vi.fn()
    const off = subscribe(listener)
    await sendMessage("hi")
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2) // user, then assistant
    const n = listener.mock.calls.length
    off()
    await sendMessage("again")
    expect(listener.mock.calls.length).toBe(n)
    await __flushBackground()
  })
})

describe("learning loop", () => {
  it("posts the right context to /api/extract", async () => {
    const net = setup()
    await sendMessage("I like my cat Pip")
    await __flushBackground()
    const body = net.of("POST /api/extract")[0].body
    expect(body).toMatchObject({
      userMessage: "I like my cat Pip", assistantReply: "reply 1", localDate: "2026-03-10", todayNotes: [],
    })
    expect(body.userMessageId).toMatch(/^m_/)
    expect(body.nodes.length).toBeLessThanOrEqual(40)
    expect(body.nodes.some((n: any) => n.name === "Pip" && Array.isArray(n.aliases))).toBe(true)
    expect(body.nodes.every((n: any) => n.type !== "day")).toBe(true)
    expect(body.facts.length).toBeLessThanOrEqual(8)
    expect(body.facts.some((f: any) => f.text.includes("grey cat"))).toBe(true)
  })

  it("lands extracted ops in the graph, and notes and coverage in today's log, right after a send", async () => {
    setup({
      extract: () => ({
        notes: ["Went climbing with a friend"],
        coverage: { activities: "climbing" },
        ops: [addFactOp("Pip", "LIKES", "Pip likes the window sill", { source_kind: "inferred", confidence: 0.9 })],
      }),
    })
    const { user } = await sendMessage("climbing today")
    await __flushBackground()
    expect(await graphFacts()).toContain("Pip likes the window sill")
    const g = (await (await getStorage()).loadGraph())!
    const edge = Object.values(g.edges).find((e) => e.text === "Pip likes the window sill")!
    expect(edge.confidence).toBe(0.6) // inferred is clamped to 0.6 by the sanitiser
    expect(edge.evidence).toEqual([user.id])
    const logs: DayLog[] = await (await getStorage()).loadDayLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ localDate: "2026-03-10", coverage: { activities: "climbing" } })
    expect(logs[0].notes).toEqual([{ t: "15:00", text: "Went climbing with a friend" }])
    const snaps = await (await getStorage()).listSnapshots()
    expect(snaps.at(-1)?.reason).toBe(`live:${user.id}`)
  })

  it("a fact learned from one message appears in the next request's memory block", async () => {
    const net = setup({
      extract: (b) =>
        b.userMessage.includes("kayak")
          ? { notes: ["Bought a kayak"], ops: [{ ...addFactOp("x", "OWNS", "Owns an orange kayak"), target: { name: "Kayak", type: "topic" } }] }
          : {},
    })
    await sendMessage("I bought a kayak")
    await __flushBackground()
    await sendMessage("what did I buy again")
    await __flushBackground()
    const second = net.of("POST /api/chat")[1].body.memory as string
    expect(second).toContain("Owns an orange kayak")
    expect(second).toContain("- Bought a kayak")
    const secondExtract = net.of("POST /api/extract")[1].body
    expect(secondExtract.todayNotes).toEqual(["Bought a kayak"])
  })

  it("keeps family-sensitive facts and notes out of the next unrelated request, but unlocks them when mentioned", async () => {
    const net = setup({
      extract: (b) =>
        b.userMessage.includes("phoned")
          ? { notes: ["Mum phoned about the move"], ops: [addFactOp("Family", "EVENT_WITH", "Argued with the relatives about the holiday plan")] }
          : {},
    })
    await sendMessage("my mum phoned me today")
    await __flushBackground()
    await sendMessage("what should I cook tonight")
    await __flushBackground()
    await sendMessage("mum is on my mind")
    await __flushBackground()
    const [first, unrelated, mentioned] = net.of("POST /api/chat").map((c) => c.body.memory as string)
    expect(first).toContain("inheritance") // she mentioned her mum, so it is unlocked
    expect(unrelated).not.toContain("inheritance")
    expect(unrelated).not.toContain("holiday plan")
    expect(unrelated).not.toContain("Mum phoned")
    expect(unrelated).toContain("Has a grey cat called Pip")
    expect(mentioned).toContain("holiday plan")
    expect(mentioned).toContain("Mum phoned")
    // the live extractor can never mark a fact sensitive itself, but this fact inherited it from the node
    const g = (await (await getStorage()).loadGraph())!
    const learned = Object.values(g.edges).find((e) => e.text.includes("holiday plan"))!
    expect(learned.sensitivity).toBe("sensitive")
  })

  it("two concurrent sends keep both messages and both learned facts", async () => {
    setup({
      chat: (b) => ({ body: { reply: `echo ${b.history.at(-1).content}` } }),
      extract: (b) => ({
        ops: [{ ...addFactOp("x", "NOTED", `Learned from ${b.userMessage}`), target: { name: `Topic ${b.userMessage}`, type: "topic" } }],
      }),
    })
    const [a, b] = await Promise.all([sendMessage("alpha"), sendMessage("beta")])
    await __flushBackground()
    expect(a.user.id).not.toBe(b.user.id)
    expect(getMessages().map((m) => m.content).sort()).toEqual(["alpha", "beta", "echo alpha", "echo beta"])
    expect((await (await getStorage()).loadMessages()).length).toBe(4)
    const facts = await graphFacts()
    expect(facts).toContain("Learned from alpha")
    expect(facts).toContain("Learned from beta")
  })

  it("applies a burst of extracts without losing updates", async () => {
    setup({
      extract: (b) => ({ ops: [{ ...addFactOp("x", "NOTED", `fact ${b.userMessage}`), target: { name: `T ${b.userMessage}`, type: "topic" } }] }),
    })
    await Promise.all(Array.from({ length: 6 }, (_, i) => sendMessage(`m${i}`)))
    await __flushBackground()
    const facts = await graphFacts()
    for (let i = 0; i < 6; i++) expect(facts).toContain(`fact m${i}`)
  })

  it("does not throw or leak unhandled rejections when extraction fails", async () => {
    for (const reply of [{ status: 500, body: "bad" }, { networkError: true }, { status: 200, body: { notes: "nope", coverage: 5, ops: "no" } }, { status: 401, body: {} }]) {
      setup({ extract: () => reply as RouteReply })
      await expect(sendMessage("hello")).resolves.toBeTruthy()
      await __flushBackground()
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(unhandled).toEqual([])
  })

  it("drops disallowed live ops (merge, sensitivity) before they reach the graph", async () => {
    setup({
      extract: () => ({
        ops: [
          { op: "set_sensitivity", target: "node", id: "zeneb", value: "sensitive" },
          { op: "merge_nodes", keep: "zeneb", drop: "Pip" },
        ],
      }),
    })
    await sendMessage("hello")
    await __flushBackground()
    const g = (await (await getStorage()).loadGraph())!
    expect(g.nodes.zeneb.sensitivity).toBe("normal")
    expect(Object.values(g.nodes).find((n) => n.name === "Pip")!.status).toBe("active")
  })
})

describe("catch-up consolidation", () => {
  const yesterdayMessages: ChatMsg[] = [
    { id: "m_100_1", role: "user", content: "I tried a new recipe", createdAt: "2026-03-09T08:00:00Z" },
    { id: "m_100_2", role: "assistant", content: "How did it go?", createdAt: "2026-03-09T08:00:05Z" },
  ]

  async function prepareYesterday() {
    const s = await getStorage()
    await s.replaceMessages(yesterdayMessages)
    await s.saveGraph(applyDiff(emptyGraph(T0), { ops: SEED_OPS }, { reason: "x", now: T0 }).graph)
  }

  it("runs on init when yesterday is unconsolidated, exactly once, and records the day", async () => {
    await prepareYesterday()
    const net = setup({
      consolidate: () => ({
        body: {
          summary: "Tried a new recipe and enjoyed it.",
          ops: [{ ...addFactOp("x", "TRIED", "Tried cooking a new recipe", { evidence: ["m_100_1", "m_ghost"] }), target: { name: "Recipe", type: "activity" } }],
          coverage: { food: "new recipe" },
        },
      }),
    })
    await initEngine()
    await initEngine()
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(1)
    const req = net.of("POST /api/consolidate")[0].body
    expect(req.localDate).toBe("2026-03-09")
    expect(req.messages.map((m: any) => m.id)).toEqual(["m_100_1", "m_100_2"])
    const g = (await (await getStorage()).loadGraph())!
    const had = Object.values(g.edges).find((e) => e.type === "HAD_DAY")!
    expect(had.text).toBe("Tried a new recipe and enjoyed it.")
    expect(g.nodes[had.target]).toMatchObject({ type: "day", name: "2026-03-09" })
    const learned = Object.values(g.edges).find((e) => e.type === "TRIED")!
    expect(learned.evidence).toEqual(["m_100_1"])
    const logs = await (await getStorage()).loadDayLogs()
    expect(logs[0]).toMatchObject({ localDate: "2026-03-09", summary: "Tried a new recipe and enjoyed it.", coverage: { food: "new recipe" } })
    expect(logs[0].consolidatedAt).not.toBeNull()
    // a later send does not consolidate again
    await sendMessage("anything")
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(1)
  })

  it("is not due before 04:00 local", async () => {
    await prepareYesterday()
    __setClock(() => new Date("2026-03-09T22:59:00Z")) // 03:59 on the 10th, so yesterday is the 9th... but 04:00 has not passed
    const net = setup()
    await initEngine()
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(0)
  })

  it("backs off for 15 minutes after a failure, then tries again", async () => {
    await prepareYesterday()
    let fail = true
    const net = setup({ consolidate: () => (fail ? { status: 502, body: { detail: "down" } } : { body: { summary: "Fine day.", ops: [], coverage: {} } }) })
    await initEngine()
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(1)
    await sendMessage("soon after")
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(1) // still backing off
    fail = false
    __setClock(() => new Date(T0.getTime() + 16 * 60 * 1000))
    await sendMessage("later on")
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(2)
    const logs = await (await getStorage()).loadDayLogs()
    expect(logs.find((l) => l.localDate === "2026-03-09")?.summary).toBe("Fine day.")
  })

  it("a malformed response changes nothing and counts as a failure", async () => {
    await prepareYesterday()
    const net = setup({ consolidate: () => ({ body: { nonsense: true } }) })
    await initEngine()
    await __flushBackground()
    const g = (await (await getStorage()).loadGraph())!
    expect(Object.values(g.edges).some((e) => e.type === "HAD_DAY")).toBe(false)
    expect(await (await getStorage()).loadDayLogs()).toEqual([])
    await sendMessage("hi")
    await __flushBackground()
    expect(net.count("POST /api/consolidate")).toBe(1)
  })

  it("never runs two consolidations concurrently", async () => {
    await prepareYesterday()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let active = 0
    let maxActive = 0
    const net = installFetch({
      "GET /api/seed": () => ({ body: { ops: SEED_OPS } }),
      "GET /api/sync": () => ({ body: { state: null } }),
      "PUT /api/sync": () => ({ body: {} }),
      "POST /api/chat": () => ({ body: { reply: "ok" } }),
      "POST /api/extract": () => ({ body: { notes: [], coverage: {}, ops: [] } }),
      "POST /api/consolidate": async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await gate
        active--
        return { body: { summary: "Done.", ops: [], coverage: {} } }
      },
    })
    const init = initEngine()
    await init
    await sendMessage("a") // learning triggers another check while the first is still waiting
    await new Promise((r) => setTimeout(r, 20))
    release()
    await __flushBackground()
    expect(maxActive).toBe(1)
    expect(net.count("POST /api/consolidate")).toBe(1)
  })
})

describe("backup", () => {
  it("is scheduled after a send and carries the graph and messages", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const net = setup({
      extract: () => ({ ops: [{ ...addFactOp("x", "NOTED", "Remembered thing"), target: { name: "Thing", type: "topic" } }] }),
    })
    await sendMessage("remember this")
    await __flushBackground()
    expect(net.count("PUT /api/sync")).toBe(0) // debounced
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    expect(net.count("PUT /api/sync")).toBe(1)
    const body = net.of("PUT /api/sync")[0].body as SyncState
    expect(body.messages.map((m) => m.content)).toEqual(["remember this", "reply 1"])
    expect(Object.values(body.graph.edges).map((e) => e.text)).toContain("Remembered thing")
    expect(Object.values(body.graph.edges).map((e) => e.text)).toContain("Has a grey cat called Pip")
  })
})

describe("AI name", () => {
  it("validateAiName applies the server rules", () => {
    expect(validateAiName("Robin")).toBe("")
    expect(validateAiName("  Mary   Jane  ")).toBe("")
    expect(validateAiName("O'Neil-Smith_2 Jr.")).toBe("")
    expect(validateAiName("Zoë Ñandú")).toBe("")
    expect(validateAiName("Dave’s Bot")).toBe("")
    expect(validateAiName("a".repeat(40))).toBe("")
    expect(validateAiName("")).not.toBe("")
    expect(validateAiName("   ")).not.toBe("")
    expect(validateAiName("a".repeat(41))).toMatch(/40/)
    expect(validateAiName("<script>")).not.toBe("")
    expect(validateAiName("Bot\nName")).toBe("") // internal whitespace is collapsed, not rejected
    expect(validateAiName("Robot!")).not.toBe("")
  })

  it("setAiName stores the normalised name, notifies, schedules a backup and persists", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const net = setup()
    await initEngine()
    const listener = vi.fn()
    subscribe(listener)
    expect(getAiName()).toBeNull()
    const saved = await setAiName("  Robin    Hood ")
    expect(saved).toBe("Robin Hood")
    expect(getAiName()).toBe("Robin Hood")
    expect(listener).toHaveBeenCalled()
    expect(await (await getStorage()).getSetting("aiName")).toBe("Robin Hood")
    await vi.advanceTimersByTimeAsync(2000)
    await __flushBackup()
    expect((net.of("PUT /api/sync")[0].body as SyncState).aiName).toBe("Robin Hood")
  })

  it("setAiName throws a readable Error for invalid names and leaves the old name", async () => {
    setup()
    await initEngine()
    await setAiName("Robin")
    await expect(setAiName("<b>")).rejects.toThrow(/letters, numbers/)
    await expect(setAiName("")).rejects.toThrow()
    expect(getAiName()).toBe("Robin")
  })

  it("is sent with chat requests", async () => {
    const net = setup()
    await setAiName("Robin")
    await sendMessage("hi")
    await __flushBackground()
    expect(net.of("POST /api/chat")[0].body.aiName).toBe("Robin")
  })
})

describe("resetLocalData", () => {
  it("clears messages, graph, day logs and the name", async () => {
    setup()
    await setAiName("Robin")
    await sendMessage("hi")
    await __flushBackground()
    await resetLocalData()
    expect(getMessages()).toEqual([])
    expect(getAiName()).toBeNull()
    const s = await getStorage()
    expect(await s.loadMessages()).toEqual([])
    expect(await s.loadGraph()).toBeNull()
    expect(await s.getSetting("aiName")).toBeNull()
  })
})
