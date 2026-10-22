import { useCallback, useEffect, useState } from "react"
import { AuthScreen } from "@/components/AuthScreen"
import { ChatScreen } from "@/components/ChatScreen"
import { clearToken, getToken, setUnauthorizedHandler } from "@/lib/session"

export default function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null)

  const logout = useCallback(() => {
    clearToken()
    setAuthed(false)
  }, [])

  // If the server says the login has expired, drop back to the password screen.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
  }, [])

  if (!authed) return <AuthScreen onAuthed={() => setAuthed(true)} />
  return <ChatScreen onLogout={logout} />
}
