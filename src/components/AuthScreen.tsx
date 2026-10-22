import { useState, type FormEvent } from "react"
import { Lock, Sparkles } from "lucide-react"
import { Backdrop } from "@/components/Backdrop"
import { saveToken } from "@/lib/session"
import type { LoginResponse } from "@shared/types"

interface Props {
  onAuthed: () => void
}

async function login(password: string): Promise<string> {
  let response: Response
  try {
    response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.")
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Something went wrong.")
  }
  return (body as LoginResponse).token
}

export function AuthScreen({ onAuthed }: Props) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError("")
    setBusy(true)
    try {
      saveToken(await login(password))
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setPassword("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-chat-theme="zeneb"
      className="relative isolate flex min-h-dvh items-center justify-center bg-[var(--chat-bg-app)] px-5 py-10"
    >
      <Backdrop />

      <div className="zeneb-glass zeneb-fade-up w-full max-w-[22rem] rounded-[28px] p-8">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="zeneb-avatar mb-5 flex size-14 items-center justify-center rounded-2xl">
            <Sparkles className="size-6" strokeWidth={2} />
          </div>
          <h1 className="font-display zeneb-gradient-text text-[2.6rem] leading-none font-semibold">
            Dear Zeneb
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--chat-text-secondary)]">
            A little corner that's just yours.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="sr-only" htmlFor="password">
            Password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-[var(--chat-text-tertiary)]" />
            <input
              id="password"
              className="zeneb-input w-full rounded-2xl py-3.5 pr-4 pl-11 text-[15px] text-[var(--chat-text-primary)] placeholder:text-[var(--chat-text-tertiary)]"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </div>

          {error && (
            <p role="alert" className="px-1 text-[13px] text-red-500">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !password}
            className="zeneb-btn mt-1 rounded-2xl px-4 py-3.5 text-[15px] font-semibold"
          >
            {busy ? "One moment..." : "Come in"}
          </button>
        </form>
      </div>
    </div>
  )
}
