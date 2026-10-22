// The doodle: scene safety net, prompt wrapper and the OpenAI Images call. Never leaks upstream error text.
import type { JournalMood } from "../../shared/types"
import { oneLine } from "./journalUtil.js"

export const NEUTRAL_SCENE = "a girl sitting at a desk with a cup of coffee"

const BLOCKED = [
  "family", "families", "mum", "mums", "mom", "moms", "mother", "mothers", "dad", "dads", "father", "fathers",
  "parent", "parents", "brother", "brothers", "sister", "sisters", "period", "periods", "cramps", "medal", "medals",
  "discipline", "disciplinary", "argue", "argues", "argued", "arguing", "argument", "arguments",
  "fight", "fights", "fighting", "fought", "shout", "shouts", "shouted", "shouting", "yell", "yells", "yelled", "yelling",
  "cry", "cries", "crying", "cried",
]
const BLOCKED_RE = new RegExp(`\\b(?:${BLOCKED.join("|")})\\b`, "i")

/** Strip control characters and trim; swap in the neutral scene when the text touches a private topic. */
export function sanitiseScene(scene: string): string {
  const clean = oneLine(scene)
  if (!clean || BLOCKED_RE.test(clean)) return NEUTRAL_SCENE
  return clean
}

export function imagePrompt(scene: string, mood?: JournalMood | null): string {
  const hint = mood ? ` The mood is ${mood}, shown only through posture.` : ""
  return (
    "A minimalist notebook doodle drawn with a black ballpoint pen: a simple stick figure (round head, line body) in this scene: " +
    `${scene}.${hint} Loose, slightly wobbly hand-drawn lines, a few tiny props, lots of empty space around it, no text, no letters, ` +
    "no numbers, no speech bubbles, no shading, no colour except at most one faint accent, transparent background, the drawing centred."
  )
}

function imageParams(prompt: string, minimal: boolean): Record<string, unknown> {
  const model = process.env.IMAGE_MODEL || "gpt-image-1"
  const body: Record<string, unknown> = { model, prompt, size: process.env.IMAGE_SIZE || "1024x1024", n: 1 }
  if (model.startsWith("dall-e")) {
    body.response_format = "b64_json"
    return body
  }
  if (!minimal) {
    body.quality = process.env.IMAGE_QUALITY || "low"
    if (model.startsWith("gpt-image")) {
      body.output_format = "png"
      body.background = "transparent"
    }
  }
  return body
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY is not set")
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    return await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fromUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("bad image url")
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error("image fetch failed")
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    const mime = /^image\/[a-z0-9.+-]+$/.test(type) ? type : "image/png"
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64")
    if (!b64) throw new Error("empty image")
    return `data:${mime};base64,${b64}`
  } finally {
    clearTimeout(timer)
  }
}

/** Returns a data URL. Throws on any failure. */
export async function generateImage(prompt: string): Promise<string> {
  const first = imageParams(prompt, false)
  const minimal = imageParams(prompt, true)
  const hasOptional = Object.keys(first).length > Object.keys(minimal).length
  let res = await post(first)
  if (res.status === 400 && hasOptional) res = await post(minimal)
  if (!res.ok) throw new Error(`image error ${res.status}`)
  const data = (await res.json()) as { data?: { b64_json?: unknown; url?: unknown }[] }
  const item = data.data?.[0]
  if (item && typeof item.b64_json === "string" && item.b64_json) {
    const fmt = typeof first.output_format === "string" ? first.output_format : "png"
    return `data:image/${fmt};base64,${item.b64_json}`
  }
  if (item && typeof item.url === "string" && item.url) return fromUrl(item.url)
  throw new Error("no image in reply")
}
