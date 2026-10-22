import type { ExtractRequest, ExtractResponse } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { cleanCoverage, cleanNotes, cleanOps } from "./_lib/clean.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { chatCompletion, parseJsonObject } from "./_lib/openai.js"
import { EXTRACT_SYSTEM_PROMPT, extractUserPrompt } from "./_lib/prompts.js"

export const config = { maxDuration: 60 }

type Obj = Record<string, unknown>
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
const objects = (v: unknown, max: number): Obj[] =>
  (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, max) as Obj[]
const strings = (v: unknown, max: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === "string").slice(0, max).map((x) => str(x, len))

/** Clamp the request to sane sizes (the prompt is built from it). null when there is no message. */
function normalise(body: unknown): ExtractRequest | null {
  const b = body as Obj | null
  if (!b || typeof b !== "object" || typeof b.userMessage !== "string" || !b.userMessage.trim()) return null
  return {
    userMessage: str(b.userMessage, 4000),
    assistantReply: str(b.assistantReply, 4000),
    userMessageId: str(b.userMessageId, 100),
    todayNotes: strings(b.todayNotes, 30, 300),
    localDate: str(b.localDate, 10),
    nodes: objects(b.nodes, 40)
      .filter((n) => typeof n.name === "string")
      .map((n) => ({ name: str(n.name, 80), type: str(n.type, 20) as ExtractRequest["nodes"][0]["type"], aliases: strings(n.aliases, 10, 80) })),
    facts: objects(b.facts, 8)
      .filter((f) => typeof f.id === "string" && typeof f.text === "string")
      .map((f) => ({ id: str(f.id, 100), text: str(f.text, 400) })),
  }
}

const EMPTY: ExtractResponse = { notes: [], coverage: {}, ops: [] }

export default route(["POST"], async (req, res) => {
  if (!requireAuth(req, res)) return
  const input = normalise(bodyOf(req))
  if (!input) return fail(res, 400, "Invalid request")
  try {
    const text = await chatCompletion({
      model: process.env.MEMORY_MODEL_FAST || "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: extractUserPrompt(input) },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      json: true,
    })
    const data = parseJsonObject(text)
    const ops = data ? cleanOps(data.ops, 12) : null
    if (!data || !ops) return void res.status(200).json(EMPTY)
    res.status(200).json({ notes: cleanNotes(data.notes), coverage: cleanCoverage(data.coverage), ops })
  } catch {
    res.status(200).json(EMPTY) // model trouble never becomes a 5xx
  }
})
