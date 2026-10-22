// Prompts and output cleaning for the daily journal page. These live only in api/ (the web bundle is public).
import { JOURNAL_MOODS, type JournalMood, type JournalRequest, type JournalResponse } from "../../shared/types"
import { NEUTRAL_SCENE, sanitiseScene } from "./imageGen.js"
import { clip, oneLine } from "./journalUtil.js"

export const JOURNAL_SYSTEM_PROMPT = `You are Zeneb, writing your own private journal page for one day. You are not an assistant; you are the person writing in her notebook at the end of the day.

VOICE
- First person ("I"). Plain, natural words, the way a real person writes in a journal. Warm, but not gushing. No flowery language, no big conclusions.
- Never sign the page. Do not put dates or day names in the text ("today" is fine).
- Never mention an AI, a chat, an assistant, or "my friend" as someone you were talking to. The page is simply what happened and how the day felt.

WHAT YOU MAY USE
- Use ONLY what Zeneb said or clearly did, in the lines labelled "Zeneb:".
- Lines labelled "Friend:" are context only. They are NEVER facts about her day. Do not take anything from them that Zeneb did not confirm herself.
- Never invent people, events, places, feelings, sensory details or lessons. If she did not say it, it is not on the page.
- If she expressed a feeling, use her own words and her own intensity. Do not analyse or diagnose her feelings, and never use words like anxiety, depression, trauma or coping.

SENSITIVE TOPICS
- Write about her family, family conflict, her period, or anything she called private ONLY if she raised it herself that day. If she did, keep it brief and gentle, without detail, and never make it the highlight of the page.

LENGTH
- Proportional to how much she shared: a few short paragraphs (1 to 6), each at most 600 characters. No filler.
- If she shared almost nothing, write one short, honest paragraph about a quiet day.

OUTPUT
Reply with strict JSON only, with exactly these keys:
{
  "title": plain, at most 60 characters, no date,
  "paragraphs": array of strings,
  "mood": one of ${JOURNAL_MOODS.map((m) => `"${m}"`).join(", ")} or null (only when she expressed how she felt),
  "scene": one gentle, concrete, drawable moment from the day, at most 240 characters, for example "a girl on a treadmill at the gym with headphones". It must NEVER be about family conflict, her period, arguments, crying, medals or discipline, or anything she marked private. Choose an everyday neutral or positive moment instead. If there is none, use "${NEUTRAL_SCENE}",
  "caption": at most 80 characters, lowercase, a handwritten feel, no emojis
}`

const LIVE_RULE =
  "This is a LIVE rewrite: the day is still going on. Keep the wording of any previous paragraph that is still accurate, and only add or adjust for new material."
const FINAL_RULE = "The day is over. Produce the best, tidy, finished page."

export function conversationBlock(messages: JournalRequest["messages"]): string {
  return messages.map((m) => `${m.role === "user" ? "Zeneb" : "Friend"}: ${m.content.trim()}`).join("\n")
}

export function journalUserPrompt(req: JournalRequest): string {
  const parts = [req.final ? FINAL_RULE : LIVE_RULE]
  if (req.previousParagraphs && req.previousParagraphs.length) {
    parts.push("Previous version of the page (paragraphs):\n" + req.previousParagraphs.map((p, i) => `${i + 1}. ${p}`).join("\n"))
  }
  parts.push("The day's conversation:\n" + conversationBlock(req.messages))
  parts.push("Write the page now as JSON.")
  return parts.join("\n\n")
}

export function journalModel(final: boolean): string {
  return final ? process.env.JOURNAL_MODEL_FINAL || "gpt-4o" : process.env.JOURNAL_MODEL_LIVE || "gpt-4o-mini"
}

const FALLBACK_CAPTION = "a day in my notebook"
const FALLBACK_TITLE = "A day in my notebook"

/** Shape the model's JSON into a JournalResponse; null when nothing usable (no paragraphs). */
export function cleanJournal(data: Record<string, unknown> | null): JournalResponse | null {
  if (!data) return null
  const raw = Array.isArray(data.paragraphs) ? data.paragraphs : []
  const paragraphs = raw
    .filter((p): p is string => typeof p === "string")
    .map((p) => clip(oneLine(p), 600))
    .filter((p) => p !== "")
    .slice(0, 6)
  if (!paragraphs.length) return null

  const title = typeof data.title === "string" ? clip(oneLine(data.title), 60) : ""
  const moodRaw = typeof data.mood === "string" ? data.mood.trim().toLowerCase() : ""
  const mood = (JOURNAL_MOODS as readonly string[]).includes(moodRaw) ? (moodRaw as JournalMood) : null
  const sceneRaw = typeof data.scene === "string" ? clip(oneLine(data.scene), 240) : ""
  const scene = sceneRaw ? sanitiseScene(sceneRaw) : NEUTRAL_SCENE
  const capRaw = typeof data.caption === "string"
    ? oneLine(data.caption.replace(/[\p{Extended_Pictographic}‍️]/gu, "")).toLowerCase()
    : ""
  const caption = clip(capRaw, 80) || FALLBACK_CAPTION
  return { title: title || FALLBACK_TITLE, paragraphs, mood, scene, caption }
}
