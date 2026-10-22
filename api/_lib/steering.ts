// Per-turn steering notes (port of lead_hint.py). A small model slips back into ending every reply
// with a question, so we look at the actual conversation and add a short, specific reminder.
export interface Turn {
  role: "user" | "assistant"
  content: string
}

const PASSIVE =
  /^\W*(sure|ok+|okay|k|idk|i dont know|i don't know|dunno|hmm+|hm+|yeah|yep|yes|no|nah|nope|nothing|whatever|idc|lol|haha+|like what|such as|what|why|maybe|fine|same)\W*$/i
const ASKS_FOR_IDEAS =
  /(like what|such as what|what should|what do we|what can we|any ideas|suggest|you pick|you choose|your pick|surprise me|entertain me|distract me)/i

export function endsWithQuestion(text: string): boolean {
  return (text || "").trimEnd().replace(/["')\]}*_ ]+$/, "").endsWith("?")
}

const assistantTexts = (history: Turn[]) => history.filter((m) => m.role === "assistant").map((m) => m.content || "")

function lastUserText(history: Turn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return (history[i].content || "").trim()
  }
  return ""
}

/** How many of the most recent assistant replies in a row ended with a question. */
export function questionStreak(history: Turn[]): number {
  let streak = 0
  for (const text of assistantTexts(history).reverse()) {
    if (!endsWithQuestion(text)) break
    streak++
  }
  return streak
}

/** A short private note for the next reply, or "" when nothing needs correcting. */
export function buildLeadHint(history: Turn[]): string {
  const notes: string[] = []
  const assistant = assistantTexts(history)
  const streak = questionStreak(history)

  if (streak >= 2) {
    notes.push(
      `Your last ${streak} replies all ended with a question. This reply must NOT contain a ` +
        "question at all: make a statement, share a thought, tease her, or suggest something.",
    )
  } else if (streak === 1) {
    notes.push(
      "Your last reply ended with a question. This reply must NOT end with a question: " +
        "react, add a thought of your own, or suggest something.",
    )
  }

  const recent = assistant.slice(-4)
  if (recent.length >= 3 && recent.filter(endsWithQuestion).length >= 3 && streak < 2) {
    notes.push("You have been asking too many questions lately. Lead the conversation instead.")
  }

  const lastUser = lastUserText(history)
  if (ASKS_FOR_IDEAS.test(lastUser)) {
    notes.push(
      "She is asking you for ideas. Decide for her: pick ONE concrete thing and go with it. " +
        "No list, no menu of options, and don't ask what she would like.",
    )
  } else if (lastUser && (lastUser.split(/\s+/).length <= 1 || PASSIVE.test(lastUser))) {
    notes.push(
      "She has given you very little to work with. Take the lead: pick one specific thing " +
        "yourself (something you know about her, a thought of your own, a small suggestion) " +
        "and run with it. Don't ask what she wants to talk about.",
    )
  }

  if (!notes.length) return ""
  return "STEERING FOR THIS REPLY (private, never mention it):\n" + notes.map((n) => `- ${n}`).join("\n")
}
