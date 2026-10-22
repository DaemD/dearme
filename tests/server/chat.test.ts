import { describe, expect, it } from "vitest"
import chat from "../../api/chat"
import { PERSONA_TEMPLATE, buildSystemPrompt, identityText } from "../../api/_lib/persona"
import { buildLeadHint, endsWithQuestion, questionStreak, type Turn } from "../../api/_lib/steering"
import { lahoreTimeLine } from "../../api/_lib/time"
import { call, installFetch, modelReply, setEnv, useEnv, validToken } from "./helpers"

useEnv()

const turn = (role: "user" | "assistant", content: string): Turn => ({ role, content })
const post = (body: unknown, token: string | null = validToken()) => call(chat, { method: "POST", body, token })
const valid = () => ({ history: [turn("user", "hello there")], aiName: null, memory: "" })

// The exchange that exposed the problem in the Python project, word for word.
const REAL_CHAT: Turn[] = [
  turn("user", "i just had such a bad day today"),
  turn("assistant", "I'm sorry to hear that. What happened?"),
  turn("user", "my exam went so ass"),
  turn("assistant", "That sounds really frustrating. Want to talk about what went wrong?"),
  turn("user", "i got 14/25 marks,"),
  turn("assistant", "That must feel disappointing. How are you feeling about it all?"),
  turn("user", "sad and awful"),
  turn("assistant", "I get that. Do you want to vent a bit more, or shift gears and talk about something else?"),
  turn("user", "sure like what"),
]

describe("validation", () => {
  const bad: [string, unknown][] = [
    ["no body", undefined],
    ["history missing", { aiName: null, memory: "" }],
    ["history empty", { ...valid(), history: [] }],
    ["history over 20", { ...valid(), history: Array.from({ length: 21 }, (_, i) => turn(i % 2 ? "assistant" : "user", "x")).concat(turn("user", "y")) }],
    ["bad role", { ...valid(), history: [{ role: "system", content: "x" }] }],
    ["content not a string", { ...valid(), history: [{ role: "user", content: 4 }] }],
    ["content too long", { ...valid(), history: [turn("user", "x".repeat(4001))] }],
    ["last is assistant", { ...valid(), history: [turn("user", "a"), turn("assistant", "b")] }],
    ["last user is blank", { ...valid(), history: [turn("user", "   ")] }],
    ["memory too long", { ...valid(), memory: "m".repeat(4001) }],
    ["memory not a string", { ...valid(), memory: 5 }],
  ]
  for (const [name, body] of bad) {
    it(`400: ${name}`, async () => {
      installFetch()
      const res = await post(body)
      expect(res.statusCode).toBe(400)
      expect(typeof (res.body as { detail: string }).detail).toBe("string")
    })
  }
  it("accepts 20 items and 4000-character content", async () => {
    installFetch()
    const history = Array.from({ length: 19 }, (_, i) => turn(i % 2 ? "assistant" : "user", "x".repeat(4000))).concat(turn("user", "z"))
    expect((await post({ ...valid(), history: history.slice(-20) })).statusCode).toBe(200)
  })
  it("treats an invalid aiName as no name instead of failing", async () => {
    for (const aiName of ["bad<name>", "", "x".repeat(41), 7, {}]) {
      const fake = installFetch()
      expect((await post({ ...valid(), aiName })).statusCode).toBe(200)
      expect(fake.calls[0].json.messages[0].content).toContain("You have not been given a name yet")
    }
  })
  it("accepts names with letters, digits, spaces, dots, hyphens and curly apostrophes", async () => {
    for (const aiName of ["Mira", "Mary-Jane O’Neil", "Zoë 2", "x".repeat(40)]) {
      const fake = installFetch()
      await post({ ...valid(), aiName })
      expect(fake.calls[0].json.messages[0].content).toContain(`Your name is ${aiName}. Zeneb gave you this name herself.`)
    }
  })
})

describe("system prompt", () => {
  it("replaces both tokens and leaves no braces tokens behind", () => {
    const p = buildSystemPrompt([turn("user", "hello there friend")], "Mira", "", new Date("2026-10-21T10:11:00Z"))
    expect(p).not.toContain("{identity}")
    expect(p).not.toContain("{current_time}")
    expect(p.startsWith("Your name is Mira. Zeneb gave you this name herself.")).toBe(true)
    expect(p).toContain("Current time where Zeneb is (Lahore): Wednesday 21 October 2026, 15:11.")
  })
  it("has an identity line without a name", () => {
    expect(identityText(null)).toMatch(/not been given a name yet.*side panel/)
    expect(PERSONA_TEMPLATE).toContain("{identity}")
    expect(PERSONA_TEMPLATE).toContain("{current_time}")
  })
  it("does not treat dollar sequences in a name as replacement patterns", () => {
    const p = buildSystemPrompt([turn("user", "hello there friend")], "A$&B", "")
    expect(p).toContain("Your name is A$&B.")
  })
  it("formats Lahore time at UTC+5, including across midnight UTC", () => {
    expect(lahoreTimeLine(new Date("2026-10-21T19:30:00Z"))).toBe(
      "Current time where Zeneb is (Lahore): Thursday 22 October 2026, 00:30.",
    )
    expect(lahoreTimeLine(new Date("2026-12-31T19:00:00Z"))).toBe(
      "Current time where Zeneb is (Lahore): Friday 1 January 2027, 00:00.",
    )
    expect(lahoreTimeLine(new Date("2026-10-21T18:59:00Z"))).toContain("Wednesday 21 October 2026, 23:59.")
    expect(lahoreTimeLine(new Date("2026-03-01T00:05:00Z"))).toContain("Sunday 1 March 2026, 05:05.")
  })
  it("puts memory then steering after the persona, in that order", () => {
    const history = [turn("user", "hey"), turn("assistant", "Hey. What are you up to?"), turn("user", "studying for mids")]
    const p = buildSystemPrompt(history, null, "WHAT YOU KNOW: placeholder")
    const mem = p.indexOf("\n\nWHAT YOU KNOW: placeholder")
    const hint = p.indexOf("\n\nSTEERING FOR THIS REPLY")
    expect(mem).toBeGreaterThan(0)
    expect(hint).toBeGreaterThan(mem)
    expect(p.endsWith("- Your last reply ended with a question. This reply must NOT end with a question: react, add a thought of your own, or suggest something.")).toBe(true)
  })
  it("adds nothing when memory is empty and no steering is needed", () => {
    const healthy = [turn("user", "went to the gym this morning"), turn("assistant", "Good."), turn("user", "legs, I can barely walk lol")]
    const p = buildSystemPrompt(healthy, null, "")
    expect(p).not.toContain("STEERING")
    expect(p.endsWith(PERSONA_TEMPLATE.slice(-50))).toBe(true)
  })
})

describe("steering (port of the Python tests)", () => {
  it("ends_with_question ignores trailing decoration", () => {
    expect(endsWithQuestion("why?")).toBe(true)
    expect(endsWithQuestion('he said "why?"  ')).toBe(true)
    expect(endsWithQuestion("really? (honestly)?)")).toBe(true)
    expect(endsWithQuestion("That's rough.")).toBe(false)
    expect(endsWithQuestion("")).toBe(false)
    expect(endsWithQuestion("Is it fine? Yes, it is.")).toBe(false)
  })
  it("no hint for a healthy conversation or an empty one", () => {
    expect(buildLeadHint([turn("user", "went to the gym this morning"), turn("assistant", "Good. Legs day or the lazy kind."), turn("user", "legs, I can barely walk lol")])).toBe("")
    expect(buildLeadHint([])).toBe("")
  })
  it("one question in a row forbids another", () => {
    const h = [turn("user", "hey"), turn("assistant", "Hey. What are you up to?"), turn("user", "studying for mids")]
    expect(buildLeadHint(h)).toContain("must NOT end with a question")
    expect(questionStreak(h)).toBe(1)
  })
  it("two or more forbid any question", () => {
    const h = [turn("user", "a"), turn("assistant", "One?"), turn("user", "b"), turn("assistant", "Two?"), turn("user", "c")]
    const hint = buildLeadHint(h)
    expect(hint).toContain("Your last 2 replies")
    expect(hint).toContain("must NOT contain a question at all")
  })
  it("the streak resets after a statement", () => {
    expect(questionStreak([turn("assistant", "Q?"), turn("assistant", "A statement."), turn("assistant", "Q again?")])).toBe(1)
  })
  it("asking for ideas gets a decision, not a menu", () => {
    const hint = buildLeadHint([turn("assistant", "Anything else?"), turn("user", "sure like what")])
    expect(hint).toContain("Decide for her")
    expect(hint).toContain("No list")
    for (const t of ["you pick", "any ideas?", "surprise me", "distract me"]) expect(buildLeadHint([turn("user", t)])).toContain("Decide for her")
  })
  it("passive replies trigger taking over", () => {
    for (const t of ["idk", "ok", "hmm", "lol", "Sure.", "whatever", "nothing", "yeah"]) {
      expect(buildLeadHint([turn("assistant", "I ran 5k today."), turn("user", t)])).toContain("very little to work with")
    }
  })
  it("real content is not passive", () => {
    for (const t of ["my exam went so ass", "sad and awful", "got 14/25"]) expect(buildLeadHint([turn("user", t)])).not.toContain("very little")
  })
  it("warns about too many questions lately when three of the last four ended with one", () => {
    const h = [turn("assistant", "A?"), turn("assistant", "B?"), turn("assistant", "C."), turn("assistant", "D?"), turn("user", "I went for a long walk today")]
    // streak is 1 (last), 3 of the last 4 ended with a question
    expect(buildLeadHint(h)).toContain("asking too many questions lately")
  })
  it("the REAL_CHAT regression gets every correction", () => {
    const hint = buildLeadHint(REAL_CHAT)
    expect(questionStreak(REAL_CHAT)).toBe(4)
    expect(hint).toContain("must NOT contain a question at all")
    expect(hint).toContain("Decide for her")
    expect(hint.startsWith("STEERING FOR THIS REPLY (private, never mention it):")).toBe(true)
  })
  it("reaches the model through the endpoint", async () => {
    const fake = installFetch()
    await post({ history: REAL_CHAT, aiName: "Mira", memory: "" })
    expect(fake.calls[0].json.messages[0].content).toContain("Decide for her")
  })
})

describe("OpenAI call", () => {
  it("sends the expected request for the default model", async () => {
    const fake = installFetch(() => modelReply("hey you"))
    const res = await post({ history: [turn("user", "hello there")], aiName: "Mira", memory: "MEM" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ reply: "hey you" })
    const c = fake.calls[0]
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions")
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key")
    expect(c.json.model).toBe("gpt-4o-mini")
    expect(c.json.max_completion_tokens).toBe(400)
    expect(c.json.temperature).toBe(0.8)
    expect(c.json.max_tokens).toBeUndefined()
    expect(c.json.top_p).toBeUndefined()
    expect(c.json.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"])
    expect(c.json.messages[0].content).toContain("\n\nMEM")
    expect(c.json.messages[1]).toEqual({ role: "user", content: "hello there" })
    expect(c.init.signal).toBeDefined()
  })
  it("omits temperature for models that are not gpt-4*", async () => {
    setEnv({ CHAT_MODEL: "gpt-5-mini" })
    const fake = installFetch()
    await post(valid())
    expect(fake.calls[0].json.model).toBe("gpt-5-mini")
    expect("temperature" in fake.calls[0].json).toBe(false)
    expect(fake.calls[0].json.max_completion_tokens).toBe(400)
  })
  it("sends temperature for gpt-4.1 style names", async () => {
    setEnv({ CHAT_MODEL: "gpt-4.1-mini" })
    const fake = installFetch()
    await post(valid())
    expect(fake.calls[0].json.temperature).toBe(0.8)
  })
  it("honours OPENAI_BASE_URL", async () => {
    setEnv({ OPENAI_BASE_URL: "https://proxy.test/v1/" })
    const fake = installFetch()
    await post(valid())
    expect(fake.calls[0].url).toBe("https://proxy.test/v1/chat/completions")
  })
  const unavailable = { detail: "The assistant is unavailable right now. Please try again." }
  it("502 when the model call fails, errors or throws", async () => {
    installFetch(() => ({ status: 500, json: { error: { message: "secret detail sk-test-key" } } }))
    const a = await post(valid())
    expect(a.statusCode).toBe(502)
    expect(a.body).toEqual(unavailable)
    installFetch(() => ({ throws: true }))
    expect((await post(valid())).body).toEqual(unavailable)
  })
  it("502 on an empty or malformed reply", async () => {
    for (const out of [modelReply(""), modelReply("   "), { json: { choices: [] } }, { json: {} }]) {
      installFetch(() => out)
      expect((await post(valid())).statusCode).toBe(502)
    }
  })
  it("502 when OPENAI_API_KEY is missing", async () => {
    setEnv({ OPENAI_API_KEY: undefined })
    installFetch()
    expect((await post(valid())).statusCode).toBe(502)
  })
  it("never leaks the key or the persona prompt in any response", async () => {
    installFetch(() => ({ status: 500, json: { error: "sk-test-key" } }))
    const fail = await post(valid())
    installFetch()
    const ok = await post(valid())
    for (const r of [fail, ok]) {
      const text = JSON.stringify(r.body)
      expect(text).not.toContain("sk-test-key")
      expect(text).not.toContain(PERSONA_TEMPLATE.slice(40, 90))
    }
    expect(Object.keys(ok.body as object)).toEqual(["reply"])
  })
  it("405 for GET", async () => {
    const res = await call(chat, { method: "GET", token: validToken() })
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe("POST")
  })
})
