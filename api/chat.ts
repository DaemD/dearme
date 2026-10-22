import type { ChatRequest } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { chatCompletion } from "./_lib/openai.js"
import { buildSystemPrompt } from "./_lib/persona.js"

export const config = { maxDuration: 60 }

const AI_NAME = /^[\p{L}\p{N}_ .'’-]+$/u
const MAX_CONTENT = 4000

/** Returns the validated request or an error message. */
function validate(body: unknown): ChatRequest | string {
  if (!body || typeof body !== "object") return "Invalid request"
  const { history, aiName, memory } = body as Record<string, unknown>
  if (!Array.isArray(history) || history.length < 1 || history.length > 20) return "history must have 1 to 20 items"
  for (const m of history) {
    const item = m as { role?: unknown; content?: unknown } | null
    if (!item || (item.role !== "user" && item.role !== "assistant")) return "Invalid history role"
    if (typeof item.content !== "string" || item.content.length > MAX_CONTENT) return "Invalid history content"
  }
  const last = history[history.length - 1] as { role: string; content: string }
  if (last.role !== "user" || !last.content.trim()) return "The last message must be from the user"
  if (memory !== undefined && memory !== null && (typeof memory !== "string" || memory.length > MAX_CONTENT)) {
    return "Invalid memory"
  }
  // An unusable name is not an error: she just has no name for the assistant.
  const name = typeof aiName === "string" && aiName.length >= 1 && aiName.length <= 40 && AI_NAME.test(aiName) ? aiName : null
  return { history: history as ChatRequest["history"], aiName: name, memory: (memory as string | null | undefined) ?? "" }
}

export default route(["POST"], async (req, res) => {
  if (!requireAuth(req, res)) return
  const parsed = validate(bodyOf(req))
  if (typeof parsed === "string") return fail(res, 400, parsed)

  try {
    const system = buildSystemPrompt(parsed.history, parsed.aiName, parsed.memory)
    const reply = await chatCompletion({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: [{ role: "system", content: system }, ...parsed.history],
      maxTokens: 400,
      temperature: 0.8,
    })
    res.status(200).json({ reply })
  } catch {
    fail(res, 502, "The assistant is unavailable right now. Please try again.")
  }
})
