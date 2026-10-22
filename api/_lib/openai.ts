// One OpenAI chat-completions call over plain fetch. Never logs keys or message text.
export interface CompletionOptions {
  model: string
  messages: { role: "system" | "user" | "assistant"; content: string }[]
  maxTokens: number
  temperature?: number // only sent for gpt-4* models; other families reject or ignore it
  json?: boolean // JSON mode
  timeoutMs?: number
}

/** Returns the reply text. Throws on any failure or an empty reply. */
export async function chatCompletion(opts: CompletionOptions): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY is not set")
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.maxTokens,
  }
  if (opts.temperature !== undefined && opts.model.startsWith("gpt-4")) body.temperature = opts.temperature
  if (opts.json) body.response_format = { type: "json_object" }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`model error ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== "string" || !text.trim()) throw new Error("empty reply")
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a model's JSON object reply, tolerating code fences and stray text around the object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  if (fence) t = fence[1]
  for (const candidate of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    try {
      const v = JSON.parse(candidate) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // try the next candidate
    }
  }
  return null
}
