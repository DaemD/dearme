// Shared contract between the browser (src/) and the Vercel functions (api/).
// IMPORTANT: this file is bundled into the public website. It must never contain anything
// personal about Zeneb (facts, the persona prompt, seed data). Those live only in api/.

// ───────────────────────── Graph (graph.json) ─────────────────────────

export const HUB_ID = "zeneb"

export type NodeType =
  | "person" | "pet" | "place" | "organisation" | "course" | "activity" | "food"
  | "event" | "goal" | "topic" | "trait" | "habit" | "preference" | "day"

export type Sensitivity = "normal" | "sensitive"
export type Status = "active" | "outdated"
export type SourceKind = "said" | "inferred"

export interface GraphNode {
  id: string
  type: NodeType
  name: string
  aliases: string[]
  summary: string
  sensitivity: Sensitivity
  status: Status
  first_seen: string // ISO-8601 UTC
  last_seen: string
}

export interface GraphEdge {
  id: string
  source: string // node id
  target: string // node id
  type: string // UPPER_SNAKE relation, e.g. HAS_PET
  text: string // the fact as a sentence (<= 300 chars)
  source_kind: SourceKind
  confidence: number // 0..1
  evidence: string[] // ids of chat messages it came from
  sensitivity: Sensitivity
  status: Status
  first_seen: string
  last_seen: string
  valid_from: string | null // YYYY-MM-DD
  valid_until: string | null // YYYY-MM-DD
  mention_count: number
}

export interface Graph {
  version: 1
  updated_at: string
  nodes: Record<string, GraphNode>
  edges: Record<string, GraphEdge>
}

// A node reference inside an op: an existing node id, an exact name/alias (case-insensitive),
// or an object that creates the node if it does not exist yet.
export type NodeRef = string | { name: string; type: NodeType }

export type Op =
  | { op: "add_node"; type: NodeType; name: string; aliases?: string[]; summary?: string; sensitivity?: Sensitivity }
  | {
      op: "add_fact"
      source: NodeRef
      target: NodeRef
      type: string
      text: string
      source_kind: SourceKind
      confidence: number
      evidence?: string[]
      sensitivity?: Sensitivity
      valid_from?: string | null
      valid_until?: string | null
    }
  | { op: "update_fact"; id: string; text?: string; confidence?: number; valid_until?: string | null; evidence_add?: string[] }
  | { op: "outdate_fact"; id: string; reason: string }
  | { op: "merge_nodes"; keep: string; drop: string }
  | { op: "set_sensitivity"; target: "node" | "fact"; id: string; value: Sensitivity }

export interface Diff {
  ops: Op[]
}

// ───────────────────────── Browser data ─────────────────────────

export interface ChatMsg {
  id: string // local id, unique and sortable, e.g. "m_1729590000000_1"
  role: "user" | "assistant"
  content: string
  createdAt: string // ISO-8601 UTC
}

export const COVERAGE_SLOTS = ["mood", "activities", "food", "study", "people", "sleep", "highlight", "plans"] as const
export type CoverageSlot = (typeof COVERAGE_SLOTS)[number]

export interface DayLog {
  localDate: string // YYYY-MM-DD in Lahore time (UTC+5)
  notes: { t: string; text: string }[] // t = "HH:MM" local
  coverage: Partial<Record<CoverageSlot, string>>
  summary: string | null
  consolidatedAt: string | null
}

// The whole backup of the browser's state (what /api/sync stores and /api/admin returns).
export interface SyncState {
  graph: Graph
  messages: ChatMsg[] // newest 300 at most
  dayLogs: DayLog[] // newest 30 at most
  aiName: string | null
  savedAt: string // ISO-8601 UTC, set by the client
}

// ───────────────────────── API (all errors are { detail: string }) ─────────────────────────
// Every endpoint except /api/login needs `Authorization: Bearer <token>`.

export interface ApiError {
  detail: string
}

// POST /api/login   -> 200 LoginResponse | 401 | 429 (Retry-After header) | 503 (ACCESS_PASSWORD not set)
export interface LoginRequest {
  password: string
}
export interface LoginResponse {
  token: string
  user: { username: string }
}

// POST /api/chat    -> 200 ChatResponse | 400 | 401 | 502 (model unavailable)
export interface ChatRequest {
  history: { role: "user" | "assistant"; content: string }[] // oldest first, at most 20, last item is the new user message
  aiName: string | null
  memory: string // the private "what you know" block built in the browser ("" if none), <= 4000 chars
}
export interface ChatResponse {
  reply: string
}

// POST /api/extract -> 200 ExtractResponse (never 5xx for model trouble: returns empty lists)
export interface ExtractRequest {
  userMessage: string
  assistantReply: string
  userMessageId: string
  todayNotes: string[]
  localDate: string // YYYY-MM-DD
  nodes: { name: string; type: NodeType; aliases: string[] }[] // up to 40 active non-day nodes
  facts: { id: string; text: string }[] // up to 8 relevant existing facts
}
export interface ExtractResponse {
  notes: string[]
  coverage: Partial<Record<CoverageSlot, string>>
  ops: Op[] // raw model output; the browser sanitises before applying
}

// POST /api/consolidate -> 200 ConsolidateResponse | 502
export interface ConsolidateRequest {
  localDate: string
  messages: { id: string; role: "user" | "assistant"; content: string }[] // at most 80
  notes: string[]
  coverage: Partial<Record<CoverageSlot, string>>
  nodes: { id: string; name: string; type: NodeType; aliases: string[] }[]
  facts: { id: string; text: string }[]
}
export interface ConsolidateResponse {
  summary: string
  ops: Op[]
  coverage: Partial<Record<CoverageSlot, string>>
}

// GET /api/seed -> 200 SeedResponse. The starting facts about Zeneb live only on the server.
export interface SeedResponse {
  ops: Op[]
}

// GET /api/sync -> 200 { state: SyncState | null } | 503 (backup storage not configured)
// PUT /api/sync (body SyncState) -> 200 { savedAt } | 413 (too large) | 503
export interface SyncGetResponse {
  state: SyncState | null
}

// GET /api/admin?what=graph|state   header X-Admin-Key (ADMIN_KEY env, 16+ chars)
//   wrong or missing key -> 404 { detail: "Not Found" } (looks like it does not exist)
//   what=graph (default) -> the Graph; what=state -> SyncState. Add &download=1 for a file download.

// ───────────────────────── Daily journal ─────────────────────────
// She just chats; one notebook page per day writes itself. The text is rewritten live while the day
// goes on and is finished once the day is over, when the doodle is drawn (once per day, never again).

export const JOURNAL_MOODS = ["happy", "calm", "tired", "sad", "stressed", "excited", "mixed"] as const
export type JournalMood = (typeof JOURNAL_MOODS)[number]

export interface JournalEntry {
  localDate: string // YYYY-MM-DD, Lahore time
  title: string // at most 60 characters
  paragraphs: string[] // 1 to 6, first person ("Today I..."), at most 600 characters each
  mood: JournalMood | null // only when she expressed it
  scene: string // plain description of ONE gentle moment, used to draw the doodle (at most 240 characters)
  caption: string // short caption under the doodle (at most 80 characters)
  basedOnMessageId: string | null // newest chat message the text was written from
  finalised: boolean // the day is over and this is the finished text
  edited: boolean // she changed the text herself: it is never overwritten again
  imageStatus: "none" | "drawing" | "ready" | "failed"
  imageAttempts: number // drawing attempts so far (give up after 3)
  updatedAt: string // ISO-8601 UTC
}

// POST /api/journal -> 200 JournalResponse | 400 | 401 | 502
export interface JournalRequest {
  localDate: string
  final: boolean // true once the day is over (uses the stronger model)
  messages: { id: string; role: "user" | "assistant"; content: string }[] // that day's messages, at most 80
  previousParagraphs?: string[] // the current text, so a live rewrite stays stable
}
export interface JournalResponse {
  title: string
  paragraphs: string[]
  mood: JournalMood | null
  scene: string
  caption: string
}

// POST /api/journal-image -> 200 JournalImageResponse | 400 | 401 | 429 (daily drawing limit) | 502
export interface JournalImageRequest {
  localDate: string
  scene: string
  caption?: string
  mood?: JournalMood | null
}
export interface JournalImageResponse {
  image: string // data URL, e.g. "data:image/png;base64,...."
}

// /api/journal-sync (backup of journal pages; each day is stored on its own, images included)
// PUT  body JournalSyncPut -> 200 { savedAt } | 400 | 413 | 503
// GET  -> 200 { dates: string[] }                                  (every day that has a backup)
// GET  ?date=YYYY-MM-DD -> 200 { entry: JournalEntry | null, image: string | null }
export interface JournalSyncPut {
  entry: JournalEntry
  image?: string | null // data URL, at most 250000 characters
}
export interface JournalSyncDates {
  dates: string[]
}
export interface JournalSyncDay {
  entry: JournalEntry | null
  image: string | null
}
// GET /api/admin?what=journals (admin key) -> { entries: JournalEntry[] }
