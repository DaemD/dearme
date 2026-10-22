import type { JournalRequest } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { cleanJournal, journalModel, journalUserPrompt, JOURNAL_SYSTEM_PROMPT } from "./_lib/journalPrompts.js"
import { isObj, isRealDate, takeDaily } from "./_lib/journalUtil.js"
import { chatCompletion, parseJsonObject } from "./_lib/openai.js"

export const config = { maxDuration: 60 }

const DAILY_JOURNAL_CALLS = 300

function normalise(body: unknown): JournalRequest | null {
  if (!isObj(body) || !isRealDate(body.localDate) || typeof body.final !== "boolean") return null
  const { messages } = body
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) return null
  const ok = messages.every(
    (m) => isObj(m) && typeof m.id === "string" && m.id.length <= 64 && (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" && m.content.length <= 4000,
  )
  if (!ok) return null
  let previous: string[] | undefined
  if (body.previousParagraphs !== undefined && body.previousParagraphs !== null) {
    const p = body.previousParagraphs
    if (!Array.isArray(p) || p.length > 6 || !p.every((x) => typeof x === "string" && x.length <= 600)) return null
    previous = p as string[]
  }
  const typed = messages as JournalRequest["messages"]
  if (!typed.some((m) => m.role === "user")) return null
  return {
    localDate: body.localDate,
    final: body.final,
    messages: typed.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    previousParagraphs: previous,
  }
}

export default route(["POST"], async (req, res) => {
  if (!requireAuth(req, res)) return
  const input = normalise(bodyOf(req))
  if (!input) return fail(res, 400, "Invalid request")
  if (!(await takeDaily("journal", DAILY_JOURNAL_CALLS))) return fail(res, 429, "That is enough for today.")
  try {
    const text = await chatCompletion({
      model: journalModel(input.final),
      messages: [
        { role: "system", content: JOURNAL_SYSTEM_PROMPT },
        { role: "user", content: journalUserPrompt(input) },
      ],
      maxTokens: 1200,
      temperature: 0.6,
      json: true,
    })
    const page = cleanJournal(parseJsonObject(text))
    if (!page) throw new Error("unusable reply")
    res.status(200).json(page)
  } catch {
    fail(res, 502, "Couldn't write the page right now.")
  }
})
