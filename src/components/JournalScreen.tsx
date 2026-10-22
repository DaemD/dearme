import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Edit2, RotateCcw, X, Check } from "lucide-react"
import {
  getJournal,
  getJournalDates,
  journalStatus,
  refreshJournal,
  retryJournalImage,
  saveJournalEdit,
  subscribeJournal,
} from "@/lib/engine"
import type { JournalView } from "@/lib/engine"

interface Props {
  onBack: () => void
}

// Ruled notebook background (CSS, inline style on the page div)
const ruledStyle: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(transparent, transparent 31px, rgba(139,92,246,0.12) 31px, rgba(139,92,246,0.12) 32px)",
  backgroundSize: "100% 32px",
  backgroundPositionY: "40px",
}

function formatDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
}

function MoodTag({ mood }: { mood: string | null }) {
  if (!mood) return null
  const colours: Record<string, string> = {
    happy: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    calm: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
    tired: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    sad: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    stressed: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    excited: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
    mixed: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colours[mood] ?? colours.mixed}`}>
      {mood}
    </span>
  )
}

function DoodleFrame({ imageDataUrl, caption, imageStatus, date, isToday }: {
  imageDataUrl: string | null
  caption: string
  imageStatus: string
  date: string
  isToday: boolean
}) {
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    setRetrying(true)
    try { await retryJournalImage(date) } finally { setRetrying(false) }
  }

  if (isToday && imageStatus === "none") {
    return (
      <div className="flex flex-col items-center gap-2 my-4">
        <div
          className="w-52 h-52 border-2 border-dashed rounded-lg flex flex-col items-center justify-center"
          style={{ borderColor: "rgba(139,92,246,0.3)" }}
        >
          <span className="text-4xl opacity-30">✏️</span>
          <p className="text-xs text-center mt-2 px-3" style={{ fontFamily: "Caveat, cursive", color: "var(--chat-text-tertiary)" }}>
            the doodle appears tomorrow
          </p>
        </div>
      </div>
    )
  }

  if (imageStatus === "drawing" || retrying) {
    return (
      <div className="flex flex-col items-center gap-2 my-4">
        <div className="w-52 h-52 border rounded-lg flex items-center justify-center" style={{ borderColor: "var(--chat-border)" }}>
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--chat-accent)", borderTopColor: "transparent" }} />
            <p className="text-xs" style={{ fontFamily: "Caveat, cursive", color: "var(--chat-text-tertiary)" }}>drawing…</p>
          </div>
        </div>
      </div>
    )
  }

  if (imageDataUrl && imageStatus === "ready") {
    return (
      <div className="flex flex-col items-center gap-2 my-4">
        {/* tape effect */}
        <div className="relative">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-14 h-4 bg-yellow-100/60 dark:bg-yellow-900/30 border border-yellow-200/50 dark:border-yellow-700/30 rounded-sm z-10 rotate-1" />
          <div className="w-52 h-52 border rounded-lg overflow-hidden bg-white dark:bg-neutral-900 shadow-sm" style={{ borderColor: "var(--chat-border)" }}>
            <img src={imageDataUrl} alt="day doodle" className="w-full h-full object-contain p-2" />
          </div>
        </div>
        {caption && (
          <p className="text-sm text-center mt-1" style={{ fontFamily: "Caveat, cursive", color: "var(--chat-text-secondary)" }}>
            {caption}
          </p>
        )}
      </div>
    )
  }

  if (imageStatus === "failed") {
    return (
      <div className="flex flex-col items-center gap-2 my-4">
        <div className="w-52 h-52 border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-2" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
          <p className="text-xs" style={{ fontFamily: "Caveat, cursive", color: "var(--chat-text-tertiary)" }}>doodle unavailable</p>
          <button
            onClick={handleRetry}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md"
            style={{ background: "var(--chat-accent-soft)", color: "var(--chat-accent)" }}
          >
            <RotateCcw size={12} /> try again
          </button>
        </div>
      </div>
    )
  }

  return null
}

function NotebookPage({ date, view, isToday, onPrev, onNext, hasPrev, hasNext }: {
  date: string
  view: JournalView | null
  isToday: boolean
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [editParagraphs, setEditParagraphs] = useState<string[]>([])
  const [editTitle, setEditTitle] = useState("")
  const [editError, setEditError] = useState("")
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    if (!view) return
    setEditParagraphs([...view.entry.paragraphs])
    setEditTitle(view.entry.title)
    setEditError("")
    setEditing(true)
  }

  const cancelEdit = () => setEditing(false)

  const commitEdit = async () => {
    setSaving(true)
    setEditError("")
    try {
      await saveJournalEdit(date, editParagraphs, editTitle)
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save.")
    } finally {
      setSaving(false)
    }
  }

  const { writing, drawingDate } = journalStatus()
  const isDrawing = drawingDate === date

  if (!view && !writing) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
        <p style={{ fontFamily: "Caveat, cursive", fontSize: "1.2rem", color: "var(--chat-text-tertiary)" }}>
          {isToday ? "chat a bit today and your page will appear here" : "no page for this day"}
        </p>
      </div>
    )
  }

  if (writing && !view) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--chat-accent)", borderTopColor: "transparent" }} />
        <p style={{ fontFamily: "Caveat, cursive", color: "var(--chat-text-tertiary)" }}>writing your page…</p>
      </div>
    )
  }

  const entry = view!.entry

  return (
    <div className="flex-1 flex flex-col items-center px-4 py-6 overflow-y-auto">
      {/* Notebook page */}
      <div
        className="w-full max-w-lg rounded-xl shadow-md relative overflow-hidden"
        style={{
          background: "var(--chat-bg-content-card)",
          border: "1px solid var(--chat-border)",
          ...ruledStyle,
          minHeight: "500px",
        }}
      >
        {/* Spiral holes */}
        <div className="absolute left-0 top-0 bottom-0 w-8 flex flex-col justify-around items-center py-4 pointer-events-none">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="w-4 h-4 rounded-full" style={{ background: "rgba(0,0,0,0.08)", border: "1px solid rgba(0,0,0,0.12)" }} />
          ))}
        </div>

        <div className="pl-12 pr-4 pt-5 pb-8">
          {/* Date + nav */}
          <div className="flex items-center justify-between mb-4">
            <button onClick={onPrev} disabled={!hasPrev} className="p-1 rounded disabled:opacity-30" aria-label="previous day">
              <ChevronLeft size={18} style={{ color: "var(--chat-text-secondary)" }} />
            </button>
            <p style={{ fontFamily: "Caveat, cursive", fontSize: "1.05rem", color: "var(--chat-text-secondary)" }}>
              {formatDate(date)}
            </p>
            <button onClick={onNext} disabled={!hasNext} className="p-1 rounded disabled:opacity-30" aria-label="next day">
              <ChevronRight size={18} style={{ color: "var(--chat-text-secondary)" }} />
            </button>
          </div>

          {/* Doodle */}
          <DoodleFrame
            imageDataUrl={view?.imageDataUrl ?? null}
            caption={entry.caption}
            imageStatus={entry.imageStatus}
            date={date}
            isToday={isToday}
          />

          {/* Title */}
          {!editing ? (
            <div className="flex items-start justify-between gap-2 mb-3">
              <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: "1.4rem", lineHeight: 1.2, color: "var(--chat-text-primary)" }}>
                {entry.title}
              </h2>
              <div className="flex items-center gap-2 flex-shrink-0 mt-1">
                <MoodTag mood={entry.mood} />
                <button onClick={startEdit} className="p-1 rounded opacity-50 hover:opacity-100" aria-label="edit page">
                  <Edit2 size={14} style={{ color: "var(--chat-text-secondary)" }} />
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-3">
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={60}
                className="w-full bg-transparent border-b pb-1 mb-2 focus:outline-none"
                style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: "1.3rem", borderColor: "var(--chat-accent)", color: "var(--chat-text-primary)" }}
              />
            </div>
          )}

          {/* Body */}
          {!editing ? (
            <div className="space-y-4">
              {entry.paragraphs.map((p, i) => (
                <p key={i} style={{ fontFamily: "Caveat, cursive", fontSize: "1.1rem", lineHeight: 1.7, color: "var(--chat-text-primary)" }}>
                  {p}
                </p>
              ))}
              {entry.edited && (
                <p className="text-xs mt-2" style={{ color: "var(--chat-text-tertiary)" }}>edited by you</p>
              )}
              {(writing || isDrawing) && (
                <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "var(--chat-text-tertiary)" }}>
                  <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--chat-accent)" }} />
                  {isDrawing ? "drawing the doodle…" : "updating your page…"}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {editParagraphs.map((p, i) => (
                <div key={i} className="relative">
                  <textarea
                    value={p}
                    onChange={(e) => {
                      const next = [...editParagraphs]
                      next[i] = e.target.value
                      setEditParagraphs(next)
                    }}
                    rows={3}
                    maxLength={600}
                    className="w-full rounded p-2 resize-none focus:outline-none bg-transparent"
                    style={{ fontFamily: "Caveat, cursive", fontSize: "1.1rem", lineHeight: 1.7, border: "1px solid var(--chat-border)", color: "var(--chat-text-primary)" }}
                  />
                  {editParagraphs.length > 1 && (
                    <button
                      onClick={() => setEditParagraphs(editParagraphs.filter((_, j) => j !== i))}
                      className="absolute top-1 right-1 p-0.5 rounded opacity-40 hover:opacity-80"
                    >
                      <X size={12} style={{ color: "var(--chat-text-secondary)" }} />
                    </button>
                  )}
                </div>
              ))}
              {editParagraphs.length < 6 && (
                <button
                  onClick={() => setEditParagraphs([...editParagraphs, ""])}
                  className="text-xs px-2 py-1 rounded"
                  style={{ color: "var(--chat-accent)", background: "var(--chat-accent-soft)" }}
                >
                  + paragraph
                </button>
              )}
              {editError && <p className="text-xs" style={{ color: "var(--chat-red)" }}>{editError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={commitEdit}
                  disabled={saving}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg"
                  style={{ background: "var(--chat-accent)", color: "#fff" }}
                >
                  <Check size={12} /> save
                </button>
                <button
                  onClick={cancelEdit}
                  className="text-xs px-3 py-1.5 rounded-lg"
                  style={{ background: "var(--chat-accent-soft)", color: "var(--chat-text-secondary)" }}
                >
                  cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function JournalScreen({ onBack }: Props) {
  const [, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const unsub = subscribeJournal(refresh)
    // Trigger a refresh of today on mount
    void refreshJournal(undefined, { force: false })
    return unsub
  }, [refresh])

  const dates = getJournalDates()
  const [idx, setIdx] = useState(0)

  // Reset to first page when dates list changes (new entry)
  const prevDatesLen = useRef(dates.length)
  useEffect(() => {
    if (dates.length > prevDatesLen.current) setIdx(0)
    prevDatesLen.current = dates.length
  }, [dates.length])

  const date = dates[idx] ?? null
  const todayDate = (() => {
    const now = new Date()
    return new Date(now.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10)
  })()
  const view = date ? getJournal(date) : null
  const isToday = date === todayDate

  return (
    <div className="h-full flex flex-col" data-chat-theme="zeneb">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0"
        style={{ background: "var(--chat-bg-header)", borderColor: "var(--chat-border)" }}
      >
        <button onClick={onBack} className="p-1.5 rounded-lg hover:opacity-70" aria-label="back to chat">
          <ChevronLeft size={20} style={{ color: "var(--chat-text-secondary)" }} />
        </button>
        <h1 className="font-display text-lg" style={{ color: "var(--chat-text-primary)" }}>
          Journal
        </h1>
        {dates.length > 1 && (
          <p className="ml-auto text-xs" style={{ color: "var(--chat-text-tertiary)" }}>
            {idx + 1} / {dates.length}
          </p>
        )}
      </div>

      {dates.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
          <p style={{ fontFamily: "Caveat, cursive", fontSize: "1.2rem", color: "var(--chat-text-tertiary)" }}>
            chat a little, and your first journal page will appear here.
          </p>
        </div>
      ) : (
        <NotebookPage
          date={date!}
          view={view}
          isToday={isToday}
          hasPrev={idx < dates.length - 1}
          hasNext={idx > 0}
          onPrev={() => setIdx((i) => Math.min(i + 1, dates.length - 1))}
          onNext={() => setIdx((i) => Math.max(i - 1, 0))}
        />
      )}
    </div>
  )
}
