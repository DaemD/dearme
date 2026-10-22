import { useCallback, useEffect, useState } from "react"
import { AuthScreen } from "@/components/AuthScreen"
import { ChatScreen } from "@/components/ChatScreen"
import { JournalScreen } from "@/components/JournalScreen"
import { clearToken, getToken, setUnauthorizedHandler } from "@/lib/session"

type View = "chat" | "journal"

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null)
  const [view, setView] = useState<View>("chat")

  const logout = useCallback(() => {
    clearToken()
    setAuthed(false)
    setView("chat")
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
  }, [])

  if (!authed) return <AuthScreen onAuthed={() => setAuthed(true)} />

  if (view === "journal") return <JournalScreen onBack={() => setView("chat")} />

  return <ChatScreen onLogout={logout} onOpenJournal={() => setView("journal")} />
}
