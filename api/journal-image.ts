import { JOURNAL_MOODS, type JournalMood } from "../shared/types"
import { requireAuth } from "./_lib/auth.js"
import { bodyOf, fail, route } from "./_lib/http.js"
import { generateImage, imagePrompt, sanitiseScene } from "./_lib/imageGen.js"
import { isObj, isRealDate, oneLine, takeDaily } from "./_lib/journalUtil.js"

export const config = { maxDuration: 60 }

const DAILY_DRAWINGS = 6

export default route(["POST"], async (req, res) => {
  if (!requireAuth(req, res)) return
  const body = bodyOf(req)
  if (!isObj(body) || !isRealDate(body.localDate) || typeof body.scene !== "string") return fail(res, 400, "Invalid request")
  const cleaned = oneLine(body.scene)
  if (!cleaned || cleaned.length > 300) return fail(res, 400, "Invalid request")
  const scene = sanitiseScene(cleaned)
  const mood = typeof body.mood === "string" && (JOURNAL_MOODS as readonly string[]).includes(body.mood) ? (body.mood as JournalMood) : null

  if (!(await takeDaily("journal-image", DAILY_DRAWINGS))) return fail(res, 429, "That is enough drawings for today.")
  try {
    const image = await generateImage(imagePrompt(scene, mood))
    res.status(200).json({ image })
  } catch {
    fail(res, 502, "Couldn't draw right now.")
  }
})
