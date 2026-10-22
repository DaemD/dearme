import { useEffect, useMemo, useState } from "react"
import { BookOpen, Menu, Sparkles } from "lucide-react"
import { ChatComposer, ChatMessages, ChatProvider } from "@/components/ui/chat"
import type { ChatMessageData, ChatUser } from "@/components/ui/chat"
import { Backdrop } from "@/components/Backdrop"
import { SidePanel } from "@/components/SidePanel"
import { getAiName, getMessages, initEngine, sendMessage, subscribe } from "@/lib/engine"

interface Props {
  onLogout: () => void
  onOpenJournal: () => void
}

const ME: ChatUser = { id: "me", name: "Zeneb", status: "online" }
const FRIEND_ID = "friend"

function greeting(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return "Good morning"
  if (hour >= 12 && hour < 17) return "Good afternoon"
  if (hour >= 17 && hour < 22) return "Good evening"
  return "Hey, night owl"
}

export function ChatScreen({ onLogout, onOpenJournal }: Props) {
  // The engine owns the data; this counter just makes React read it again when it changes.
  const [, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)

  const [ready, setReady] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const aiName = getAiName()
  const friendName = aiName || "Your friend"
  // On phones the panel opens by itself until a name has been chosen
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    initEngine()
      .catch((err) => console.warn("engine init failed", err))
      .finally(() => {
        if (cancelled) return
        setReady(true)
        setPanelOpen(!getAiName())
        refresh()
      })
    const unsubscribe = subscribe(() => {
      if (!cancelled) refresh()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const stored = getMessages()
  const lastUserId = [...stored].reverse().find((m) => m.role === "user")?.id

  const messages = useMemo<ChatMessageData[]>(
    () =>
      stored.map((m) => ({
        id: m.id,
        senderId: m.role === "user" ? ME.id : FRIEND_ID,
        senderName: m.role === "user" ? ME.name : friendName,
        text: m.content,
        timestamp: new Date(m.createdAt),
        status:
          m.role !== "user"
            ? undefined
            : m.id === failedId
              ? "failed"
              : waiting && m.id === lastUserId
                ? "sending"
                : "sent",
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, friendName, waiting, failedId, lastUserId]
  )

  const typingUsers = useMemo(
    () => (waiting ? [{ id: FRIEND_ID, name: friendName }] : []),
    [waiting, friendName]
  )

  const send = async (text: string) => {
    setError("")
    setFailedId(null)
    setWaiting(true)
    try {
      await sendMessage(text)
    } catch (err) {
      const last = [...getMessages()].reverse().find((m) => m.role === "user")
      if (last) setFailedId(last.id)
      setError(err instanceof Error ? err.message : "Something went wrong.")
    } finally {
      setWaiting(false)
      refresh()
    }
  }

  return (
    <div data-chat-theme="zeneb" className="relative isolate flex h-dvh bg-[var(--chat-bg-app)]">
      <Backdrop />

      <SidePanel
        aiName={aiName}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onNameSaved={() => {
          setPanelOpen(false)
          refresh()
        }}
        onLogout={onLogout}
      />

      <ChatProvider currentUser={ME} theme="zeneb" className="flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex items-center gap-3 border-b border-[var(--chat-border)] bg-[var(--chat-bg-header)] px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur-2xl backdrop-saturate-150">
          <button
            onClick={() => setPanelOpen(true)}
            className="rounded-xl p-1.5 text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)] md:hidden"
            aria-label="Open side panel"
          >
            <Menu className="size-5" />
          </button>
          <div className="relative">
            <div className="zeneb-avatar flex size-10 items-center justify-center rounded-full text-[15px] font-semibold">
              {(aiName || "?").charAt(0).toUpperCase()}
            </div>
            <span className="zeneb-online absolute right-0 bottom-0 size-3 rounded-full border-2 border-[var(--chat-bg-main)] bg-[var(--chat-green)]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-display truncate text-[1.1rem] leading-tight font-semibold text-[var(--chat-text-primary)]">
              {friendName}
            </span>
            <span className="truncate text-[12px] text-[var(--chat-text-secondary)]">
              {waiting ? "typing..." : "online"}
            </span>
          </div>
          <button
            onClick={onOpenJournal}
            className="rounded-xl p-1.5 text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)] flex-shrink-0"
            aria-label="Open journal"
            title="Journal"
          >
            <BookOpen className="size-5" />
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {ready && messages.length === 0 && (
            <div className="zeneb-fade-up pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center px-8 text-center">
              <div className="zeneb-avatar mb-5 flex size-14 items-center justify-center rounded-2xl">
                <Sparkles className="size-6" />
              </div>
              <p className="font-display zeneb-gradient-text text-[2rem] leading-tight font-semibold">
                {greeting()}, Zeneb.
              </p>
              <p className="mt-2 max-w-xs text-[14px] leading-relaxed text-[var(--chat-text-secondary)]">
                {aiName
                  ? `${aiName} is here whenever you feel like talking.`
                  : "Give your friend a name in the side panel, then say hi."}
              </p>
            </div>
          )}
          <ChatMessages messages={messages} typingUsers={typingUsers} />
        </div>

        {error && (
          <p
            role="alert"
            className="border-t border-[var(--chat-border)] bg-[var(--chat-bg-composer)] px-4 py-2 text-center text-[13px] text-red-500 backdrop-blur-xl"
          >
            {error}
          </p>
        )}
        <div className="pb-[env(safe-area-inset-bottom)]">
          <ChatComposer
            onSend={send}
            disabled={waiting || !ready}
            placeholder={aiName ? `Message ${aiName}` : "Message"}
          />
        </div>
      </ChatProvider>
    </div>
  )
}
