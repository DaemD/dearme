import { describe, expect, it, vi } from "vitest"
import type { ChatMsg, DayLog, Graph } from "../../shared/types"
import {
  KNOWLEDGE_HEADER, MAX_CONTEXT_CHARS, TODAY_HEADER, buildMemoryContext,
} from "../../src/lib/memory/context"
import {
  applyConsolidation, buildConsolidateRequest, consolidationDue,
} from "../../src/lib/memory/consolidation"
import {
  addDayNotes, coverageGaps, localDateStr, localTimeHHMM, newDayLog,
} from "../../src/lib/memory/daylog"
import { applyDiff, emptyGraph } from "../../src/lib/memory/graph"
import { sanitiseLiveOps } from "../../src/lib/memory/sanitize"

const NOW = new Date("2026-03-10T10:00:00Z")

function fact(target: unknown, type: string, text: string, extra: Record<string, unknown> = {}) {
  return { op: "add_fact", source: "zeneb", target, type, text, source_kind: "said", confidence: 0.9, ...extra }
}
function build(ops: unknown[]): Graph {
  return applyDiff(emptyGraph(NOW), { ops }, { reason: "t", now: NOW }).graph
}
const edges = (g: Graph) => Object.values(g.edges)

// ───────────────────────────── daylog ─────────────────────────────

describe("daylog local time (UTC+5)", () => {
  it("shifts date and time by five hours", () => {
    expect(localDateStr(new Date("2026-03-10T10:00:00Z"))).toBe("2026-03-10")
    expect(localTimeHHMM(new Date("2026-03-10T10:00:00Z"))).toBe("15:00")
  })

  it("rolls to the next local day at 19:00 UTC", () => {
    expect(localDateStr(new Date("2026-03-10T18:59:59Z"))).toBe("2026-03-10")
    expect(localDateStr(new Date("2026-03-10T19:00:00Z"))).toBe("2026-03-11")
    expect(localDateStr(new Date("2026-03-10T19:30:00Z"))).toBe("2026-03-11")
    expect(localTimeHHMM(new Date("2026-03-10T19:30:00Z"))).toBe("00:30")
  })

  it("handles month and year boundaries", () => {
    expect(localDateStr(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01")
    expect(localDateStr(new Date("2028-02-28T19:00:00Z"))).toBe("2028-02-29")
  })
})

describe("addDayNotes / coverageGaps", () => {
  it("adds notes with the local time and dedupes", () => {
    const log = addDayNotes(null, ["Had toast", "Had toast", "  ", "Went for a walk"], {}, new Date("2026-03-10T19:30:00Z"))
    expect(log.localDate).toBe("2026-03-11")
    expect(log.notes).toEqual([{ t: "00:30", text: "Had toast" }, { t: "00:30", text: "Went for a walk" }])
    const again = addDayNotes(log, ["Had toast", "New thing"], {}, NOW)
    expect(again.notes.map((n) => n.text)).toEqual(["Had toast", "Went for a walk", "New thing"])
    expect(log.notes).toHaveLength(2) // input not mutated
  })

  it("caps at 40 notes per day and 200 chars per note", () => {
    const notes = Array.from({ length: 50 }, (_, i) => `note ${i}`)
    const log = addDayNotes(null, notes, {}, NOW)
    expect(log.notes).toHaveLength(40)
    const long = addDayNotes(null, ["x".repeat(500)], {}, NOW)
    expect(long.notes[0].text).toHaveLength(200)
  })

  it("keeps only known coverage slots and overwrites a slot with newer text", () => {
    let log = addDayNotes(null, [], { mood: "good", bogus: "x", food: "" }, NOW)
    expect(log.coverage).toEqual({ mood: "good" })
    log = addDayNotes(log, [], { mood: "tired" }, NOW)
    expect(log.coverage.mood).toBe("tired")
  })

  it("lists the gaps in slot order", () => {
    expect(coverageGaps(null)).toEqual(["mood", "activities", "food", "study", "people", "sleep", "highlight", "plans"])
    const log = addDayNotes(null, [], { mood: "a", sleep: "b" }, NOW)
    expect(coverageGaps(log)).toEqual(["activities", "food", "study", "people", "highlight", "plans"])
  })

  it("never throws on junk input", () => {
    expect(() => addDayNotes(null, 42, "nope", NOW)).not.toThrow()
    expect(addDayNotes(null, "single note", null, NOW).notes).toHaveLength(1)
  })
})

// ───────────────────────────── sanitiser ─────────────────────────────

describe("sanitiseLiveOps", () => {
  const today = "2026-03-10"

  it("allows only add_node, add_fact, update_fact and outdate_fact", () => {
    const ops = [
      { op: "add_node", type: "place", name: "Town" },
      { op: "merge_nodes", keep: "a", drop: "b" },
      { op: "set_sensitivity", target: "node", id: "x", value: "sensitive" },
      { op: "update_fact", id: "e_1", text: "x" },
      { op: "outdate_fact", id: "e_1", reason: "r" },
      "junk",
      null,
    ]
    expect(sanitiseLiveOps(ops, today, "m1").map((o) => o.op)).toEqual(["add_node", "update_fact", "outdate_fact"])
  })

  it("caps the list at 6", () => {
    const ops = Array.from({ length: 10 }, (_, i) => ({ op: "add_node", type: "topic", name: `T${i}` }))
    expect(sanitiseLiveOps(ops, today, null)).toHaveLength(6)
  })

  it("clamps inferred confidence to 0.6 and leaves said alone", () => {
    const out = sanitiseLiveOps(
      [
        fact("a", "T", "x", { source_kind: "inferred", confidence: 0.7 }),
        fact("a", "T", "y", { source_kind: "inferred", confidence: 0.4 }),
        fact("a", "T", "z", { source_kind: "said", confidence: 0.95 }),
      ],
      today, "m1",
    ) as unknown as { confidence: number }[]
    expect(out.map((o) => o.confidence)).toEqual([0.6, 0.4, 0.95])
  })

  it("clamps valid_until to local today + 30 days and drops unparseable values", () => {
    const out = sanitiseLiveOps(
      [
        fact("a", "T", "far", { valid_until: "2030-01-01" }),
        fact("a", "T", "near", { valid_until: "2026-03-20" }),
        fact("a", "T", "edge", { valid_until: "2026-04-09" }),
        fact("a", "T", "junk", { valid_until: "next week" }),
        fact("a", "T", "null", { valid_until: null }),
        { op: "update_fact", id: "e_1", valid_until: "2099-12-31" },
      ],
      today, "m1",
    ) as unknown as { valid_until?: string }[]
    expect(out[0].valid_until).toBe("2026-04-09")
    expect(out[1].valid_until).toBe("2026-03-20")
    expect(out[2].valid_until).toBe("2026-04-09")
    expect("valid_until" in out[3]).toBe(false)
    expect("valid_until" in out[4]).toBe(false)
    expect(out[5].valid_until).toBe("2026-04-09")
  })

  it("requires add_fact text and drops over-long text", () => {
    const out = sanitiseLiveOps(
      [fact("a", "T", ""), fact("a", "T", "x".repeat(301)), fact("a", "T", "x".repeat(300)), { op: "update_fact", id: "e", text: "y".repeat(301) }],
      today, "m1",
    )
    expect(out).toHaveLength(1)
  })

  it("strips sensitivity from every live op", () => {
    const out = sanitiseLiveOps(
      [
        { op: "add_node", type: "place", name: "Town", sensitivity: "sensitive" },
        fact("a", "T", "x", { sensitivity: "sensitive" }),
        { op: "update_fact", id: "e", text: "x", sensitivity: "sensitive" },
      ],
      today, "m1",
    )
    for (const op of out) expect("sensitivity" in op).toBe(false)
  })

  it("sets evidence to the user message id when missing or empty, keeps given evidence", () => {
    const out = sanitiseLiveOps(
      [fact("a", "T", "x"), fact("a", "T", "y", { evidence: [] }), fact("a", "T", "z", { evidence: ["m0"] })],
      today, "m7",
    ) as unknown as { evidence: string[] }[]
    expect(out.map((o) => o.evidence)).toEqual([["m7"], ["m7"], ["m0"]])
  })

  it("does not mutate its input and tolerates non-arrays", () => {
    const op: Record<string, unknown> = fact("a", "T", "x", { sensitivity: "sensitive" })
    sanitiseLiveOps([op], today, "m1")
    expect(op.sensitivity).toBe("sensitive")
    expect(sanitiseLiveOps("nope", today, null)).toEqual([])
  })
})

// ───────────────────────────── context ─────────────────────────────

describe("buildMemoryContext", () => {
  const gaps = (slots: string) =>
    `NOT YET KNOWN ABOUT TODAY: ${slots}. If it fits naturally, you may work in at most one of these, ` +
    "never as a question list and never as an interrogation."

  it("renders the exact format", () => {
    const g = build([
      fact({ name: "Pip", type: "pet" }, "HAS_PET", "Has a grey cat called Pip", { confidence: 0.95 }),
      fact({ name: "Riverside College", type: "organisation" }, "STUDIES_AT", "Studies at Riverside College", { confidence: 0.9 }),
      fact({ name: "Gym", type: "activity" }, "DOES", "Goes climbing on Sundays", { confidence: 0.4 }),
    ])
    const log = addDayNotes(null, ["Had porridge", "Felt tired"], { mood: "tired", food: "porridge" }, NOW)
    const text = buildMemoryContext({ graph: g, dayLog: log, message: "climbing today", now: NOW })
    expect(text).toBe(
      [
        KNOWLEDGE_HEADER,
        "- Has a grey cat called Pip",
        "- Studies at Riverside College",
        "- Goes climbing on Sundays",
        "",
        TODAY_HEADER,
        "- Had porridge",
        "- Felt tired",
        "- mood: tired",
        "- food: porridge",
        "",
        gaps("activities, study, people, sleep, highlight, plans"),
      ].join("\n"),
    )
    expect(KNOWLEDGE_HEADER).toBe("WHAT YOU KNOW ABOUT ZENEB (private notes: use naturally and sparingly, never recite them back):")
  })

  it("with an empty graph and no log only the gaps line remains", () => {
    const text = buildMemoryContext({ graph: emptyGraph(NOW), dayLog: null, message: "hi", now: NOW })
    expect(text).toBe(gaps("mood, activities, food, study, people, sleep, highlight, plans"))
  })

  it("dedupes core and relevant facts and limits each list to 8", () => {
    const ops = Array.from({ length: 12 }, (_, i) =>
      fact({ name: `Place ${i}`, type: "place" }, `TYPE_${i}`, `Visits orchard number ${i}`, { confidence: 0.9 - i * 0.01 }))
    const text = buildMemoryContext({ graph: build(ops), dayLog: null, message: "orchard", now: NOW })
    const lines = text.split("\n").filter((l) => l.startsWith("- Visits"))
    expect(lines).toHaveLength(12)
    expect(new Set(lines).size).toBe(lines.length)
    const relevantOnly = lines.slice(8)
    expect(relevantOnly).toHaveLength(4)
  })

  it("keeps only the last 8 notes", () => {
    const notes = Array.from({ length: 12 }, (_, i) => `note-${i}`)
    const log = addDayNotes(null, notes, {}, NOW)
    const text = buildMemoryContext({ graph: emptyGraph(NOW), dayLog: log, message: "", now: NOW })
    expect(text).toContain("- note-11")
    expect(text).toContain("- note-4")
    expect(text).not.toContain("- note-3")
  })

  it("stays within 2800 characters and trims gaps, coverage, core, notes, relevant in that order", () => {
    const long = (s: string) => `${s} ${"w".repeat(280)}`
    const coreOps = Array.from({ length: 8 }, (_, i) => fact({ name: `Core ${i}`, type: "topic" }, `C${i}`, long(`core${i}`), { confidence: 0.99 }))
    const relOps = Array.from({ length: 8 }, (_, i) => fact({ name: `Rel ${i}`, type: "topic" }, `R${i}`, long(`pebble${i}`), { confidence: 0.61 }))
    const g = build([...coreOps, ...relOps])
    const log = addDayNotes(null, Array.from({ length: 8 }, (_, i) => `note ${i} ${"n".repeat(150)}`), { mood: "fine" }, NOW)
    const text = buildMemoryContext({ graph: g, dayLog: log, message: "pebble0 pebble1 pebble2 pebble3 pebble4 pebble5 pebble6 pebble7", now: NOW })
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(text).not.toContain("NOT YET KNOWN")
    expect(text).not.toContain("- mood:")
    // core (priority 3) and notes (2) are dropped before the relevant facts (1)
    expect(text).not.toContain("core0")
    expect(text).not.toContain("note 7")
    expect(text).toContain("pebble0")
  })

  it("drops later lines of the same priority first", () => {
    const long = (s: string) => `${s} ${"w".repeat(290)}`
    const ops = Array.from({ length: 8 }, (_, i) => fact({ name: `Core ${i}`, type: "topic" }, `C${i}`, long(`item${i}`), { confidence: 0.99 - i * 0.01 }))
    const log = addDayNotes(null, Array.from({ length: 8 }, (_, i) => `note ${i} ${"n".repeat(180)}`), {}, NOW)
    const text = buildMemoryContext({ graph: build(ops), dayLog: log, message: "", now: NOW })
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(text).toContain("item0")
    expect(text).not.toContain("item7")
    expect(text).toContain("note 7")
    expect(text).not.toContain("NOT YET KNOWN")
  })

  describe("sensitivity gating", () => {
    const g = build([
      { op: "add_node", type: "person", name: "Family", sensitivity: "sensitive", aliases: ["mum", "dad"] },
      fact("Family", "FAMILY_RELATIONSHIP", "Argues with relatives about inheritance paperwork", { confidence: 0.95 }),
      fact({ name: "Pip", type: "pet" }, "HAS_PET", "Has a cat called Pip", { confidence: 0.9 }),
    ])
    const log = addDayNotes(
      null,
      ["Mum phoned about the move", "Had pasta for lunch"],
      { people: "talked to mum", food: "pasta" },
      NOW,
    )

    it("hides sensitive facts, notes and coverage from an unrelated message", () => {
      const text = buildMemoryContext({ graph: g, dayLog: log, message: "what should I cook tonight", now: NOW })
      expect(text).toContain("Has a cat called Pip")
      expect(text).toContain("Had pasta for lunch")
      expect(text).not.toContain("inheritance")
      expect(text).not.toContain("Mum phoned")
      expect(text).not.toContain("talked to mum")
    })

    it("hidden coverage still counts as known (the slot is not listed as a gap)", () => {
      const text = buildMemoryContext({ graph: g, dayLog: log, message: "what should I cook tonight", now: NOW })
      const gapLine = text.split("\n").find((l) => l.startsWith("NOT YET KNOWN"))!
      expect(gapLine).not.toMatch(/people/)
      expect(gapLine).not.toMatch(/food/)
    })

    it("unlocks when the message mentions a node name or alias as a whole word", () => {
      const text = buildMemoryContext({ graph: g, dayLog: log, message: "my mum called today", now: NOW })
      expect(text).toContain("inheritance")
      expect(text).toContain("Mum phoned")
      expect(text).toContain("- people: talked to mum")
    })

    it("does not unlock on a partial word", () => {
      const text = buildMemoryContext({ graph: g, dayLog: log, message: "I am feeling mummified and dadaist", now: NOW })
      expect(text).not.toContain("inheritance")
    })

    it("unlocks on a distinctive 5+ character keyword of the fact, but not on generic words", () => {
      const keyword = buildMemoryContext({ graph: g, dayLog: log, message: "the inheritance thing again", now: NOW })
      expect(keyword).toContain("inheritance")
      const generic = buildMemoryContext({ graph: g, dayLog: log, message: "relationship advice, mostly sometimes", now: NOW })
      expect(generic).not.toContain("inheritance")
    })
  })

  it("never throws and returns an empty string on internal error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(buildMemoryContext({ graph: null as never, dayLog: null, message: "hi", now: NOW })).toBe("")
    expect(buildMemoryContext({ graph: { nodes: {}, edges: null } as never, dayLog: undefined, message: "hi", now: NOW })).toBe("")
    warn.mockRestore()
  })
})

// ───────────────────────────── consolidation ─────────────────────────────

function msg(id: string, role: "user" | "assistant", iso: string, content = "hello"): ChatMsg {
  return { id, role, content, createdAt: iso }
}

describe("consolidationDue", () => {
  const yesterdayMsgs = [msg("m_1_1", "user", "2026-03-10T08:00:00Z"), msg("m_1_2", "assistant", "2026-03-10T08:00:05Z")]

  it("is due from 04:00 local (23:00 UTC) with user messages yesterday", () => {
    expect(consolidationDue(yesterdayMsgs, [], new Date("2026-03-10T22:59:59Z"))).toBeNull() // 03:59 local
    expect(consolidationDue(yesterdayMsgs, [], new Date("2026-03-10T23:00:00Z"))).toBe("2026-03-10")
    expect(consolidationDue(yesterdayMsgs, [], new Date("2026-03-11T08:00:00Z"))).toBe("2026-03-10")
  })

  it("uses the Lahore offset to decide which day a message belongs to", () => {
    const now = new Date("2026-03-11T08:00:00Z") // local 2026-03-11
    // 2026-03-09T19:30Z is local 00:30 on the 10th: yesterday
    expect(consolidationDue([msg("a", "user", "2026-03-09T19:30:00Z")], [], now)).toBe("2026-03-10")
    // 2026-03-10T19:30Z is local 00:30 on the 11th: today, so nothing is due
    expect(consolidationDue([msg("b", "user", "2026-03-10T19:30:00Z")], [], now)).toBeNull()
    // 2026-03-09T18:30Z is local 23:30 on the 9th: two days ago
    expect(consolidationDue([msg("c", "user", "2026-03-09T18:30:00Z")], [], now)).toBeNull()
  })

  it("is not due when already consolidated, or when yesterday has only assistant messages", () => {
    const now = new Date("2026-03-11T08:00:00Z")
    const done: DayLog = { ...newDayLog("2026-03-10"), consolidatedAt: "2026-03-11T00:00:00Z" }
    expect(consolidationDue(yesterdayMsgs, [done], now)).toBeNull()
    expect(consolidationDue(yesterdayMsgs, [newDayLog("2026-03-10")], now)).toBe("2026-03-10")
    expect(consolidationDue([msg("x", "assistant", "2026-03-10T08:00:00Z")], [], now)).toBeNull()
    expect(consolidationDue([], [], now)).toBeNull()
  })
})

describe("buildConsolidateRequest", () => {
  it("takes the last 80 messages of that local day and truncates content to 600 chars", () => {
    const messages: ChatMsg[] = []
    for (let i = 0; i < 100; i++) {
      messages.push(msg(`m_${i}`, i % 2 ? "assistant" : "user", `2026-03-10T08:${String(i % 60).padStart(2, "0")}:00Z`, "z".repeat(900)))
    }
    messages.push(msg("other", "user", "2026-03-09T08:00:00Z"))
    const g = build([fact({ name: "Pip", type: "pet" }, "HAS_PET", "Has a cat called Pip")])
    const req = buildConsolidateRequest({ graph: g, messages, dayLog: null, localDate: "2026-03-10" })
    expect(req.messages).toHaveLength(80)
    expect(req.messages[0].id).toBe("m_20")
    expect(req.messages[79].id).toBe("m_99")
    expect(req.messages.every((m) => m.content.length === 600)).toBe(true)
    expect(req.localDate).toBe("2026-03-10")
    expect(req.nodes.some((n) => n.name === "Pip")).toBe(true)
    expect(req.facts.length).toBeGreaterThan(0)
  })

  it("carries notes and coverage", () => {
    const log = addDayNotes(null, ["a note"], { mood: "ok" }, NOW)
    const req = buildConsolidateRequest({ graph: emptyGraph(NOW), messages: [], dayLog: log, localDate: "2026-03-10" })
    expect(req.notes).toEqual(["a note"])
    expect(req.coverage).toEqual({ mood: "ok" })
  })
})

describe("applyConsolidation", () => {
  const day = "2026-03-10"
  const messages = [msg("m_real_1", "user", "2026-03-10T08:00:00Z"), msg("m_real_2", "assistant", "2026-03-10T08:01:00Z")]
  const later = new Date("2026-03-11T08:00:00Z")
  const base = () => build([fact({ name: "Pip", type: "pet" }, "HAS_PET", "Has a cat called Pip")])

  it("applies ops, adds the day node and HAD_DAY fact, filters evidence, and marks the log", () => {
    const summary = "s".repeat(400)
    const out = applyConsolidation(
      base(),
      addDayNotes(null, [], { mood: "calm" }, NOW),
      {
        summary,
        ops: [fact({ name: "Cafe", type: "place" }, "VISITED", "Went to a cafe", { evidence: ["m_real_1", "m_made_up"] })],
        coverage: { mood: "different", food: "toast", bogus: "x" },
      },
      { localDate: day, messages, now: later },
    )
    expect(out.changed).toBe(true)
    expect(out.applied).toBe(1)
    const cafe = edges(out.graph).find((e) => e.type === "VISITED")!
    expect(cafe.evidence).toEqual(["m_real_1"])
    const dayNode = Object.values(out.graph.nodes).find((n) => n.type === "day" && n.name === day)!
    expect(dayNode).toBeDefined()
    const had = edges(out.graph).find((e) => e.type === "HAD_DAY")!
    expect(had).toMatchObject({ source: "zeneb", target: dayNode.id, source_kind: "inferred", confidence: 0.7 })
    expect(had.text).toHaveLength(300)
    expect(had.evidence).toEqual(["m_real_1", "m_real_2"])
    expect(out.dayLog.summary).toBe(summary)
    expect(out.dayLog.consolidatedAt).toBe(later.toISOString())
    expect(out.dayLog.coverage).toEqual({ mood: "calm", food: "toast" }) // model coverage fills empty slots only
  })

  it("reports model ops beyond 40 as rejected and only applies the first 40", () => {
    const ops = Array.from({ length: 45 }, (_, i) => ({ op: "add_node", type: "topic", name: `Topic ${i}` }))
    const out = applyConsolidation(base(), null, { summary: "ok", ops, coverage: {} }, { localDate: day, messages, now: later })
    expect(out.applied).toBe(40)
    expect(out.rejected).toHaveLength(5)
    expect(Object.values(out.graph.nodes).filter((n) => n.name.startsWith("Topic "))).toHaveLength(40)
  })

  it("reports rejected model ops without counting its own bookkeeping ops", () => {
    const out = applyConsolidation(base(), null, { summary: "ok", ops: [{ op: "outdate_fact", id: "e_nope", reason: "x" }], coverage: {} }, { localDate: day, messages, now: later })
    expect(out.applied).toBe(0)
    expect(out.rejected).toHaveLength(1)
    expect(out.changed).toBe(true)
  })

  it("outdates an earlier HAD_DAY fact when the day is re-consolidated with a different summary", () => {
    const first = applyConsolidation(base(), null, { summary: "first take", ops: [], coverage: {} }, { localDate: day, messages, now: later })
    const second = applyConsolidation(first.graph, first.dayLog, { summary: "second take", ops: [], coverage: {} }, { localDate: day, messages, now: later })
    const had = edges(second.graph).filter((e) => e.type === "HAD_DAY")
    expect(had).toHaveLength(2)
    expect(had.filter((e) => e.status === "active").map((e) => e.text)).toEqual(["second take"])
    expect(Object.values(second.graph.nodes).filter((n) => n.type === "day")).toHaveLength(1)
  })

  it("changes nothing for a malformed or failed response", () => {
    const g = base()
    const log = newDayLog(day)
    const bad: unknown[] = [null, undefined, "text", {}, { summary: "", ops: [] }, { summary: "x" }, { summary: "x", ops: "no" }, { summary: 5, ops: [] }]
    for (const response of bad) {
      const out = applyConsolidation(g, log, response, { localDate: day, messages, now: later })
      expect(out.changed).toBe(false)
      expect(out.graph).toBe(g)
      expect(out.dayLog.consolidatedAt).toBeNull()
      expect(out.dayLog.summary).toBeNull()
    }
  })
})
