import type { ConsolidateRequest } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { cleanCoverage, cleanOps } from "./_lib/clean.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { chatCompletion, parseJsonObject } from "./_lib/openai.js"
import { CONSOLIDATION_SYSTEM_PROMPT, consolidationUserPrompt } from "./_lib/prompts.js"

export const config = { maxDuration: 60 }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)
const objects = (v: unknown, max: number): Obj[] => (Array.isArray(v) ? v : []).filter(isObj).slice(0, max)
const strings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").slice(0, max)

function normalise(body: unknown): ConsolidateRequest | null {
  if (!isObj(body) || typeof body.localDate !== "string") return null
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length > 80) return null
  const valid = messages.every(
    (m) => isObj(m) && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length <= 4000,
  )
  if (!valid) return null
  return {
    localDate: body.localDate.slice(0, 10),
    messages: messages as ConsolidateRequest["messages"],
    notes: strings(body.notes, 60).map((n) => n.slice(0, 300)),
    coverage: cleanCoverage(body.coverage),
    nodes: objects(body.nodes, 300)
      .filter((n) => typeof n.id === "string" && typeof n.name === "string")
      .map((n) => ({ id: String(n.id), name: String(n.name).slice(0, 80), type: n.type as ConsolidateRequest["nodes"][0]["type"], aliases: strings(n.aliases, 10) })),
    facts: objects(body.facts, 300)
      .filter((f) => typeof f.id === "string" && typeof f.text === "string")
      .map((f) => ({ id: String(f.id), text: String(f.text).slice(0, 400) })),
  }
}

export default route(["POST"], async (req, res) => {
  if (!requireAuth(req, res)) return
  const input = normalise(bodyOf(req))
  if (!input) return fail(res, 400, "Invalid request")
  try {
    const text = await chatCompletion({
      model: process.env.MEMORY_MODEL_SLOW || "gpt-4o",
      messages: [
        { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: "user", content: consolidationUserPrompt(input) },
      ],
      maxTokens: 4000,
      temperature: 0.2,
      json: true,
    })
    const data = parseJsonObject(text)
    const ops = data ? cleanOps(data.ops, 40) : null
    if (!data || !ops || typeof data.summary !== "string" || !data.summary.trim()) throw new Error("invalid reply")
    res.status(200).json({ summary: data.summary.trim(), ops, coverage: cleanCoverage(data.coverage) })
  } catch {
    fail(res, 502, "Consolidation is unavailable right now.")
  }
})
