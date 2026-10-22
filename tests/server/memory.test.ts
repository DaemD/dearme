import { describe, expect, it, vi } from "vitest"
import consolidate from "../../api/consolidate"
import extract from "../../api/extract"
import { CONSOLIDATION_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT } from "../../api/_lib/prompts"
import { call, installFetch, modelReply, setEnv, useEnv, validToken } from "./helpers"

useEnv()

const extractBody = () => ({
  userMessage: "my exam went badly, 14/25",
  assistantReply: "Okay, that stings.",
  userMessageId: "m_1",
  todayNotes: ["Zeneb said she woke up early"],
  localDate: "2026-10-21",
  nodes: [{ name: "Alex", type: "person", aliases: ["Al"] }],
  facts: [{ id: "e_1", text: "Alex is a friend of Zeneb" }],
})
const runExtract = (body: unknown = extractBody()) => call(extract, { method: "POST", body, token: validToken() })
const EMPTY = { notes: [], coverage: {}, ops: [] }

describe("extract", () => {
  it("builds the prompt from the request and calls the fast model in JSON mode", async () => {
    const fake = installFetch(() => modelReply(JSON.stringify(EMPTY)))
    await runExtract()
    const j = fake.calls[0].json
    expect(j.model).toBe("gpt-4o-mini")
    expect(j.response_format).toEqual({ type: "json_object" })
    expect(j.messages[0]).toEqual({ role: "system", content: EXTRACT_SYSTEM_PROMPT })
    const user = j.messages[1].content as string
    for (const part of ["2026-10-21", "- Zeneb said she woke up early", "Alex | person | Al", "e_1 | Alex is a friend of Zeneb", "my exam went badly, 14/25", "Okay, that stings."]) {
      expect(user).toContain(part)
    }
  })
  it("honours MEMORY_MODEL_FAST", async () => {
    setEnv({ MEMORY_MODEL_FAST: "gpt-4.1-nano" })
    const fake = installFetch(() => modelReply("{}"))
    await runExtract()
    expect(fake.calls[0].json.model).toBe("gpt-4.1-nano")
  })
  it("shapes and limits the model output", async () => {
    const ops = Array.from({ length: 15 }, (_, i) => ({ op: "add_node", type: "topic", name: `n${i}` }))
    const out = {
      notes: ["a", "b", "c", "d", "x".repeat(201), 5],
      coverage: { mood: "sad", sleep: "", food: "y".repeat(201), unknown: "nope", plans: "gym tomorrow" },
      ops: ["junk", 4, null, ...ops],
    }
    installFetch(() => modelReply(JSON.stringify(out)))
    const res = await runExtract()
    const body = res.body as { notes: string[]; coverage: Record<string, string>; ops: unknown[] }
    expect(body.notes).toEqual(["a", "b", "c"])
    expect(body.coverage).toEqual({ mood: "sad", plans: "gym tomorrow" })
    expect(body.ops).toHaveLength(12)
    expect(body.ops.every((o) => typeof o === "object")).toBe(true)
  })
  it("strips code fences", async () => {
    installFetch(() => modelReply("```json\n" + JSON.stringify({ notes: ["n"], coverage: {}, ops: [] }) + "\n```"))
    expect((await runExtract()).body).toEqual({ notes: ["n"], coverage: {}, ops: [] })
  })
  it("returns the empty result on model failure, garbage, non-JSON, or ops that are not an array", async () => {
    const outs: any[] = [
      { status: 500 }, { throws: true }, modelReply("not json at all"), modelReply("[1,2]"),
      modelReply(JSON.stringify({ notes: ["x"], ops: "nope" })), modelReply(JSON.stringify({ notes: ["x"] })), { json: {} },
    ]
    for (const o of outs) {
      installFetch(() => o)
      const res = await runExtract()
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual(EMPTY)
    }
  })
  it("returns the empty result without an API key (never 5xx)", async () => {
    setEnv({ OPENAI_API_KEY: undefined })
    installFetch()
    const res = await runExtract()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(EMPTY)
  })
  it("400 without a user message, and clamps oversized lists", async () => {
    installFetch()
    expect((await runExtract({})).statusCode).toBe(400)
    const fake = installFetch(() => modelReply("{}"))
    const big = { ...extractBody(), nodes: Array.from({ length: 100 }, (_, i) => ({ name: `Node${i}`, type: "topic", aliases: [] })) }
    await runExtract(big)
    const user = fake.calls[0].json.messages[1].content as string
    expect(user).toContain("Node39 |")
    expect(user).not.toContain("Node40 |")
  })
})

const consolidateBody = () => ({
  localDate: "2026-10-21",
  messages: [
    { id: "m_1", role: "user", content: "I had a long day" },
    { id: "m_2", role: "assistant", content: "Go make a coffee." },
  ],
  notes: ["Zeneb had a long day"],
  coverage: { mood: "tired" },
  nodes: [{ id: "n_1", name: "Alex", type: "person", aliases: [] }],
  facts: [{ id: "e_1", text: "Alex is a friend of Zeneb" }],
})
const runConsolidate = (body: unknown = consolidateBody()) => call(consolidate, { method: "POST", body, token: validToken() })

describe("consolidate", () => {
  it("returns summary, ops and coverage, using the slow model", async () => {
    const out = { summary: "She had a long day.", ops: [{ op: "outdate_fact", id: "e_1", reason: "finished" }], coverage: { mood: "tired", bogus: "x" } }
    const fake = installFetch(() => modelReply(JSON.stringify(out)))
    const res = await runConsolidate()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ summary: "She had a long day.", ops: out.ops, coverage: { mood: "tired" } })
    const j = fake.calls[0].json
    expect(j.model).toBe("gpt-4o")
    expect(j.response_format).toEqual({ type: "json_object" })
    expect(j.messages[0].content).toBe(CONSOLIDATION_SYSTEM_PROMPT)
    expect(j.messages[1].content).toContain("[m_1] user: I had a long day")
    expect(j.messages[1].content).toContain("n_1 | person | Alex | ")
  })
  it("keeps at most 40 ops", async () => {
    const ops = Array.from({ length: 60 }, () => ({ op: "add_node", type: "topic", name: "t" }))
    installFetch(() => modelReply(JSON.stringify({ summary: "ok", ops })))
    expect(((await runConsolidate()).body as { ops: unknown[] }).ops).toHaveLength(40)
  })
  it("honours MEMORY_MODEL_SLOW", async () => {
    setEnv({ MEMORY_MODEL_SLOW: "gpt-4.1" })
    const fake = installFetch(() => modelReply(JSON.stringify({ summary: "ok", ops: [] })))
    await runConsolidate()
    expect(fake.calls[0].json.model).toBe("gpt-4.1")
  })
  it("502 on failure, invalid JSON, missing summary or bad ops", async () => {
    const outs: any[] = [
      { status: 500 }, { throws: true }, modelReply("nope"), modelReply(JSON.stringify({ ops: [] })),
      modelReply(JSON.stringify({ summary: "", ops: [] })), modelReply(JSON.stringify({ summary: "x", ops: "no" })),
    ]
    for (const o of outs) {
      installFetch(() => o)
      const res = await runConsolidate()
      expect(res.statusCode).toBe(502)
      expect(typeof (res.body as { detail: string }).detail).toBe("string")
    }
  })
  it("400 for an invalid request (too many messages, bad shape)", async () => {
    installFetch()
    const many = { ...consolidateBody(), messages: Array.from({ length: 81 }, (_, i) => ({ id: `m${i}`, role: "user", content: "x" })) }
    expect((await runConsolidate(many)).statusCode).toBe(400)
    expect((await runConsolidate({ localDate: "2026-10-21" })).statusCode).toBe(400)
    expect((await runConsolidate({ ...consolidateBody(), messages: [{ id: 1, role: "user", content: "x" }] })).statusCode).toBe(400)
  })
  it("does not log message text", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")]
    installFetch(() => ({ status: 500 }))
    await runConsolidate()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    spies.forEach((s) => s.mockRestore())
  })
})
