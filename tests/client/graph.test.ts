import { describe, expect, it } from "vitest"
import type { Graph } from "../../shared/types"
import { applyDiff, coreProfile, emptyGraph, search, tokenize } from "../../src/lib/memory/graph"

const NOW = new Date("2026-03-10T10:00:00Z")
const opts = (reason = "test", now = NOW) => ({ reason, now })

function fact(target: unknown, type: string, text: string, extra: Record<string, unknown> = {}) {
  return { op: "add_fact", source: "zeneb", target, type, text, source_kind: "said", confidence: 0.9, ...extra }
}

function build(ops: unknown[]): Graph {
  const r = applyDiff(emptyGraph(NOW), { ops }, opts())
  return r.graph
}

const byName = (g: Graph, name: string) => Object.values(g.nodes).find((n) => n.name === name)!
const edges = (g: Graph) => Object.values(g.edges)

describe("emptyGraph", () => {
  it("has the hub node", () => {
    const g = emptyGraph(NOW)
    expect(g.nodes.zeneb).toMatchObject({ id: "zeneb", type: "person", name: "Zeneb", status: "active" })
    expect(g.version).toBe(1)
    expect(g.edges).toEqual({})
  })
})

describe("applyDiff basics", () => {
  it("add_node creates, merges aliases and never duplicates", () => {
    let g = build([{ op: "add_node", type: "pet", name: "Pip", aliases: ["the cat"], summary: "A grey cat" }])
    expect(Object.keys(g.nodes)).toHaveLength(2)
    const pip = byName(g, "Pip")
    expect(pip.id).toMatch(/^n_[0-9a-f]{8}$/)
    g = applyDiff(g, { ops: [{ op: "add_node", type: "pet", name: "pip", aliases: ["kitty", "THE CAT"] }] }, opts()).graph
    expect(Object.keys(g.nodes)).toHaveLength(2)
    expect(byName(g, "Pip").aliases).toEqual(["the cat", "kitty"])
  })

  it("add_fact creates edges with ids, resolves refs by id, name and alias, and creates {name,type}", () => {
    const g = build([
      { op: "add_node", type: "pet", name: "Pip", aliases: ["the cat"] },
      fact("pip", "HAS_PET", "Has a cat called Pip"),
      fact("THE CAT", "LIKES", "The cat likes naps"),
      fact({ name: "Riverside College", type: "organisation" }, "STUDIES_AT", "Studies at Riverside College"),
    ])
    expect(edges(g)).toHaveLength(3)
    expect(edges(g)[0].id).toMatch(/^e_[0-9a-f]{8}$/)
    expect(byName(g, "Riverside College").type).toBe("organisation")
    const pipId = byName(g, "Pip").id
    const g2 = applyDiff(g, { ops: [fact(pipId, "WATCHES", "Watches Pip")] }, opts()).graph
    expect(edges(g2)).toHaveLength(4)
  })

  it("rejects unknown refs without leaving created nodes behind", () => {
    const r = applyDiff(
      emptyGraph(NOW),
      { ops: [fact({ name: "Newplace", type: "place" }, "T", "x") , { ...fact("nobody", "T", "y"), source: { name: "Ghost", type: "person" } }] },
      opts(),
    )
    expect(r.applied).toBe(1)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]).toMatchObject({ op: "add_fact", index: 1 })
    expect(Object.values(r.graph.nodes).some((n) => n.name === "Ghost")).toBe(false)
  })

  it("does not mutate the input graph", () => {
    const g = emptyGraph(NOW)
    const copy = JSON.stringify(g)
    applyDiff(g, { ops: [{ op: "add_node", type: "place", name: "Town" }] }, opts())
    expect(JSON.stringify(g)).toBe(copy)
  })

  it("returns the same graph object when nothing applied", () => {
    const g = emptyGraph(NOW)
    const r = applyDiff(g, { ops: [{ op: "nonsense" }] }, opts())
    expect(r.applied).toBe(0)
    expect(r.graph).toBe(g)
  })

  it("a bad diff shape is reported", () => {
    const r = applyDiff(emptyGraph(NOW), { ops: "no" } as never, opts())
    expect(r.applied).toBe(0)
    expect(r.rejected[0].error).toMatch(/ops/)
  })
})

describe("validation rules", () => {
  it("rejects inferred facts above 0.7 and accepts 0.7", () => {
    const r = applyDiff(
      emptyGraph(NOW),
      {
        ops: [
          { op: "add_node", type: "place", name: "Town" },
          fact("Town", "T", "a", { source_kind: "inferred", confidence: 0.71 }),
          fact("Town", "T", "b", { source_kind: "inferred", confidence: 0.7 }),
        ],
      },
      opts(),
    )
    expect(r.applied).toBe(2)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].error).toMatch(/0.7/)
  })

  it("clamps confidence to [0,1] and rejects non-numbers", () => {
    const g = build([
      { op: "add_node", type: "place", name: "Town" },
      fact("Town", "A", "high", { confidence: 5 }),
      fact("Town", "B", "low", { confidence: -2 }),
    ])
    const confs = edges(g).map((e) => e.confidence).sort()
    expect(confs).toEqual([0, 1])
    const r = applyDiff(g, { ops: [fact("Town", "C", "bad", { confidence: "high" })] }, opts())
    expect(r.rejected).toHaveLength(1)
  })

  it("strips control characters and enforces length limits", () => {
    const g = build([
      { op: "add_node", type: "place", name: "Bad\u0000\u0007Name" + "x".repeat(200) },
      fact({ name: "Town", type: "place" }, "T", "line\u0001one" + "y".repeat(400)),
    ])
    const node = Object.values(g.nodes).find((n) => n.name.startsWith("Bad"))!
    expect(node.name).toHaveLength(80)
    expect(node.name).not.toMatch(/[\u0000-\u001f]/)
    expect(edges(g)[0].text.length).toBeLessThanOrEqual(300)
    expect(edges(g)[0].text).not.toMatch(/[\u0000-\u001f]/)
  })

  it("requires text, a known source_kind and a valid type, source and node type", () => {
    const g = build([{ op: "add_node", type: "place", name: "Town" }])
    const r = applyDiff(
      g,
      {
        ops: [
          fact("Town", "T", "   "),
          fact("Town", "T", "ok", { source_kind: "guess" }),
          fact("Town", "", "ok"),
          fact("Town", "T", "same", { source: "Town" }),
          { op: "add_node", type: "wizard", name: "X" },
          { op: "add_node", type: "place", name: "" },
        ],
      },
      opts(),
    )
    expect(r.applied).toBe(0)
    expect(r.rejected).toHaveLength(6)
  })

  it("normalises the edge type to UPPER_SNAKE and validates dates", () => {
    const g = build([
      { op: "add_node", type: "place", name: "Town" },
      fact("Town", "lives in!", "Lives in town", { valid_until: "2027-01-05T12:00:00Z" }),
    ])
    expect(edges(g)[0].type).toBe("LIVES_IN")
    expect(edges(g)[0].valid_until).toBe("2027-01-05")
    const r = applyDiff(g, { ops: [fact("Town", "T", "d", { valid_until: "2027-13-45" })] }, opts())
    expect(r.rejected).toHaveLength(1)
  })

  it("caps a diff at 80 ops and reports the excess", () => {
    const ops = Array.from({ length: 85 }, (_, i) => ({ op: "add_node", type: "topic", name: `Topic ${i}` }))
    const r = applyDiff(emptyGraph(NOW), { ops }, opts())
    expect(r.applied).toBe(80)
    expect(r.rejected).toHaveLength(5)
    expect(r.rejected[0].error).toMatch(/too many/)
    expect(r.rejected[0].index).toBe(80)
  })

  it("applies valid ops and reports invalid ones in the same diff", () => {
    const r = applyDiff(
      emptyGraph(NOW),
      { ops: [{ op: "add_node", type: "place", name: "Town" }, { op: "explode" }, "junk", { op: "add_node", type: "place", name: "Hill" }] },
      opts(),
    )
    expect(r.applied).toBe(2)
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2])
    expect(r.rejected[0].error).toMatch(/unknown op/)
  })
})

describe("dedupe", () => {
  it("bumps the existing fact instead of adding a duplicate", () => {
    let g = build([
      { op: "add_node", type: "place", name: "Town" },
      fact("Town", "LIKES", "Likes the town!", { confidence: 0.8, evidence: ["m1"] }),
    ])
    const id = edges(g)[0].id
    g = applyDiff(
      g,
      { ops: [fact("Town", "LIKES", "likes the town", { confidence: 0.8, evidence: ["m1", "m2"] })] },
      opts("again", new Date("2026-03-11T10:00:00Z")),
    ).graph
    expect(edges(g)).toHaveLength(1)
    const e = g.edges[id]
    expect(e.mention_count).toBe(2)
    expect(e.confidence).toBeCloseTo(0.85)
    expect(e.evidence).toEqual(["m1", "m2"])
    expect(e.last_seen).toBe("2026-03-11T10:00:00Z")
  })

  it("caps confidence at 1.0 when said and 0.7 when inferred", () => {
    let g = build([
      { op: "add_node", type: "place", name: "Town" },
      fact("Town", "A", "said fact", { confidence: 0.98 }),
      fact("Town", "B", "guess", { source_kind: "inferred", confidence: 0.68 }),
    ])
    for (let i = 0; i < 2; i++) {
      g = applyDiff(
        g,
        { ops: [fact("Town", "A", "said fact", { confidence: 0.98 }), fact("Town", "B", "guess", { source_kind: "inferred", confidence: 0.68 })] },
        opts(),
      ).graph
    }
    const said = edges(g).find((e) => e.type === "A")!
    const guess = edges(g).find((e) => e.type === "B")!
    expect(said.confidence).toBe(1)
    expect(guess.confidence).toBe(0.7)
  })

  it("does not dedupe against outdated facts", () => {
    let g = build([{ op: "add_node", type: "place", name: "Town" }, fact("Town", "A", "x")])
    g = applyDiff(g, { ops: [{ op: "outdate_fact", id: edges(g)[0].id, reason: "changed" }] }, opts()).graph
    g = applyDiff(g, { ops: [fact("Town", "A", "x")] }, opts()).graph
    expect(edges(g)).toHaveLength(2)
  })
})

describe("update, outdate and set_sensitivity", () => {
  const base = () => build([{ op: "add_node", type: "place", name: "Town" }, fact("Town", "A", "original", { confidence: 0.8 })])

  it("update_fact changes text, confidence, valid_until and adds evidence", () => {
    const g = base()
    const id = edges(g)[0].id
    const r = applyDiff(
      g,
      { ops: [{ op: "update_fact", id, text: "revised", confidence: 0.95, valid_until: "2026-12-01", evidence_add: ["m9"] }] },
      opts(),
    )
    expect(r.graph.edges[id]).toMatchObject({ text: "revised", confidence: 0.95, valid_until: "2026-12-01", evidence: ["m9"] })
  })

  it("update_fact can clear valid_until with null and rejects empty updates and unknown ids", () => {
    let g = build([{ op: "add_node", type: "place", name: "Town" }, fact("Town", "A", "x", { valid_until: "2026-12-01" })])
    const id = edges(g)[0].id
    g = applyDiff(g, { ops: [{ op: "update_fact", id, valid_until: null }] }, opts()).graph
    expect(g.edges[id].valid_until).toBeNull()
    const r = applyDiff(g, { ops: [{ op: "update_fact", id }, { op: "update_fact", id: "e_nope", text: "x" }, { op: "update_fact", id, text: " " }] }, opts())
    expect(r.rejected).toHaveLength(3)
  })

  it("update_fact keeps the inferred cap", () => {
    const g = build([{ op: "add_node", type: "place", name: "Town" }, fact("Town", "A", "x", { source_kind: "inferred", confidence: 0.5 })])
    const r = applyDiff(g, { ops: [{ op: "update_fact", id: edges(g)[0].id, confidence: 0.9 }] }, opts())
    expect(r.rejected).toHaveLength(1)
  })

  it("outdate_fact needs a reason and never deletes", () => {
    const g = base()
    const id = edges(g)[0].id
    const bad = applyDiff(g, { ops: [{ op: "outdate_fact", id, reason: "  " }, { op: "outdate_fact", id }] }, opts())
    expect(bad.applied).toBe(0)
    const ok = applyDiff(g, { ops: [{ op: "outdate_fact", id, reason: "no longer true" }] }, opts())
    expect(ok.graph.edges[id].status).toBe("outdated")
    expect(Object.keys(ok.graph.edges)).toContain(id)
  })

  it("set_sensitivity works on nodes and facts and validates", () => {
    const g = base()
    const id = edges(g)[0].id
    const nodeId = byName(g, "Town").id
    const r = applyDiff(
      g,
      {
        ops: [
          { op: "set_sensitivity", target: "node", id: nodeId, value: "sensitive" },
          { op: "set_sensitivity", target: "fact", id, value: "sensitive" },
          { op: "set_sensitivity", target: "node", id: "n_nope", value: "sensitive" },
          { op: "set_sensitivity", target: "fact", id, value: "secret" },
          { op: "set_sensitivity", target: "thing", id, value: "normal" },
        ],
      },
      opts(),
    )
    expect(r.applied).toBe(2)
    expect(r.rejected).toHaveLength(3)
    expect(r.graph.nodes[nodeId].sensitivity).toBe("sensitive")
    expect(r.graph.edges[id].sensitivity).toBe("sensitive")
  })
})

describe("merge_nodes", () => {
  function merged() {
    const g = build([
      { op: "add_node", type: "pet", name: "Pip", aliases: ["cat"] },
      { op: "add_node", type: "pet", name: "Pippin", aliases: ["fluff"], summary: "Fluffy" },
      fact("Pip", "HAS_PET", "Has a cat", { evidence: ["m1"] }),
      fact("Pippin", "HAS_PET", "Has a cat", { evidence: ["m2"] }),
      fact("Pippin", "LIKES", "Pippin likes fish"),
    ])
    const keep = byName(g, "Pip").id
    const drop = byName(g, "Pippin").id
    const r = applyDiff(g, { ops: [{ op: "merge_nodes", keep, drop }] }, opts())
    return { r, keep, drop }
  }

  it("re-points edges, merges aliases and marks the dropped node outdated", () => {
    const { r, keep, drop } = merged()
    expect(r.applied).toBe(1)
    expect(r.graph.nodes[drop].status).toBe("outdated")
    expect(r.graph.nodes[drop]).toBeDefined()
    expect(r.graph.nodes[keep].aliases).toEqual(expect.arrayContaining(["cat", "Pippin", "fluff"]))
    expect(r.graph.nodes[keep].summary).toBe("Fluffy")
    expect(edges(r.graph).every((e) => e.source !== drop && e.target !== drop)).toBe(true)
  })

  it("outdates facts that became duplicates and merges their evidence", () => {
    const { r } = merged()
    const dupes = edges(r.graph).filter((e) => e.type === "HAS_PET")
    expect(dupes).toHaveLength(2)
    const active = dupes.filter((e) => e.status === "active")
    expect(active).toHaveLength(1)
    expect(active[0].evidence).toEqual(["m1", "m2"])
    expect(active[0].mention_count).toBe(2)
    expect(edges(r.graph)).toHaveLength(3)
  })

  it("rejects merging a node into itself or dropping the hub", () => {
    const g = build([{ op: "add_node", type: "pet", name: "Pip" }])
    const pip = byName(g, "Pip").id
    const r = applyDiff(g, { ops: [{ op: "merge_nodes", keep: pip, drop: pip }, { op: "merge_nodes", keep: pip, drop: "zeneb" }] }, opts())
    expect(r.applied).toBe(0)
    expect(r.rejected).toHaveLength(2)
  })
})

describe("sensitivity inheritance", () => {
  const sensitiveOps = [
    { op: "add_node", type: "person", name: "Family", sensitivity: "sensitive", aliases: ["mum"] },
    fact("Family", "FAMILY_RELATIONSHIP", "A private family matter"),
  ]

  it("a fact touching a sensitive node is created sensitive", () => {
    const g = build(sensitiveOps)
    expect(edges(g)[0].sensitivity).toBe("sensitive")
  })

  it("is inherited at read time when the node becomes sensitive later", () => {
    let g = build([{ op: "add_node", type: "person", name: "Sam" }, fact("Sam", "KNOWS", "Knows Sam well")])
    expect(search(g, "Sam", 5, false)).toHaveLength(1)
    g = applyDiff(g, { ops: [{ op: "set_sensitivity", target: "node", id: byName(g, "Sam").id, value: "sensitive" }] }, opts()).graph
    expect(edges(g)[0].sensitivity).toBe("normal")
    expect(search(g, "Sam", 5, false)).toHaveLength(0)
    expect(search(g, "Sam", 5, true)[0].sensitivity).toBe("sensitive")
  })

  it("an explicit sensitivity on add_fact is honoured", () => {
    const g = build([{ op: "add_node", type: "place", name: "Town" }, fact("Town", "A", "secret", { sensitivity: "sensitive" })])
    expect(edges(g)[0].sensitivity).toBe("sensitive")
  })
})

describe("tokenize", () => {
  it("lowercases, drops stopwords and folds plurals", () => {
    expect([...tokenize("The Cats are walking to Riverside's park")].sort()).toEqual(["cat", "park", "riverside", "walking"])
  })
})

describe("search", () => {
  const g = build([
    { op: "add_node", type: "pet", name: "Pip", aliases: ["kitty"] },
    { op: "add_node", type: "person", name: "Family", sensitivity: "sensitive" },
    fact("Pip", "HAS_PET", "Has a grey cat called Pip"),
    fact("Family", "FAMILY_RELATIONSHIP", "Has tension with the family about holidays"),
    fact({ name: "Riverside College", type: "organisation" }, "STUDIES_AT", "Studies chemistry at Riverside"),
    fact({ name: "Trip", type: "event" }, "HAS_UPCOMING", "A trip to the coast", { valid_until: "2026-03-01" }),
    fact({ name: "Exam", type: "event" }, "HAS_UPCOMING", "Final exam preparation", { valid_until: "2026-03-10" }),
  ])

  it("scores by keyword overlap with facts, names and aliases", () => {
    expect(search(g, "how is my cat", 5, false, NOW)[0].text).toMatch(/grey cat/)
    expect(search(g, "kitty", 5, false, NOW)[0].text).toMatch(/grey cat/)
    expect(search(g, "chemistry", 5, false, NOW)[0].text).toMatch(/chemistry/)
  })

  it("returns nothing for blank, stopword-only or unrelated queries", () => {
    expect(search(g, "   ", 5, false, NOW)).toEqual([])
    expect(search(g, "the and of", 5, false, NOW)).toEqual([])
    expect(search(g, "zebra", 5, false, NOW)).toEqual([])
  })

  it("respects the validity window using UTC dates (valid_until == today is still valid)", () => {
    expect(search(g, "trip coast", 5, false, NOW)).toEqual([])
    expect(search(g, "exam", 5, false, NOW)).toHaveLength(1)
    expect(search(g, "exam", 5, false, new Date("2026-03-11T00:00:00Z"))).toEqual([])
  })

  it("excludes sensitive facts unless asked, and outdated facts always", () => {
    expect(search(g, "family holidays", 5, false, NOW)).toEqual([])
    expect(search(g, "family holidays", 5, true, NOW)).toHaveLength(1)
    const id = edges(g).find((e) => e.type === "HAS_PET")!.id
    const out = applyDiff(g, { ops: [{ op: "outdate_fact", id, reason: "gone" }] }, opts()).graph
    expect(search(out, "cat", 5, true, NOW)).toEqual([])
  })

  it("honours k", () => {
    expect(search(g, "exam cat chemistry", 2, false, NOW)).toHaveLength(2)
    expect(search(g, "exam cat chemistry", 0, false, NOW)).toHaveLength(0)
  })
})

describe("coreProfile", () => {
  it("excludes HAD_DAY, low confidence, outdated and (optionally) sensitive facts", () => {
    const g = build([
      { op: "add_node", type: "person", name: "Family", sensitivity: "sensitive" },
      { op: "add_node", type: "day", name: "2026-03-09" },
      fact("Family", "FAMILY", "sensitive one"),
      fact("2026-03-09", "HAD_DAY", "A calm day", { source_kind: "inferred", confidence: 0.7 }),
      fact({ name: "Town", type: "place" }, "LIVES_IN", "Lives in Town", { confidence: 0.5 }),
      fact({ name: "Hill", type: "place" }, "LIVES_NEAR", "Lives near Hill", { confidence: 0.9 }),
    ])
    const open = coreProfile(g, 10, false, NOW).map((f) => f.text)
    expect(open).toEqual(["Lives near Hill"])
    const all = coreProfile(g, 10, true, NOW).map((f) => f.text)
    expect(all).toEqual(expect.arrayContaining(["Lives near Hill", "sensitive one"]))
    expect(all).not.toContain("A calm day")
    expect(all).not.toContain("Lives in Town")
  })

  it("round-robins by edge type so one type cannot fill the list", () => {
    const ops: unknown[] = []
    for (let i = 0; i < 6; i++) ops.push(fact({ name: `Food ${i}`, type: "food" }, "LIKES", `Likes food ${i}`, { confidence: 0.99 }))
    ops.push(fact({ name: "Gym", type: "activity" }, "DOES", "Goes to the gym", { confidence: 0.7 }))
    ops.push(fact({ name: "Town", type: "place" }, "LIVES_IN", "Lives in Town", { confidence: 0.65 }))
    const picked = coreProfile(build(ops), 3, false, NOW).map((f) => f.type)
    expect(new Set(picked)).toEqual(new Set(["LIKES", "DOES", "LIVES_IN"]))
  })

  it("ranks by confidence, then recency, then mentions", () => {
    let g = build([
      fact({ name: "A", type: "topic" }, "T1", "low", { confidence: 0.7 }),
      fact({ name: "B", type: "topic" }, "T1", "high", { confidence: 0.95 }),
    ])
    g = applyDiff(g, { ops: [fact({ name: "C", type: "topic" }, "T2", "mid", { confidence: 0.8 })] }, opts()).graph
    expect(coreProfile(g, 3, false, NOW).map((f) => f.text)).toEqual(["high", "mid", "low"])
  })
})
