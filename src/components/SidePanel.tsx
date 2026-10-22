import { useEffect, useState, type FormEvent } from "react"
import { LogOut, Monitor, Moon, Pencil, Sun, X } from "lucide-react"
import { setAiName, validateAiName } from "@/lib/engine"
import { getThemePref, setThemePref, type ThemePref } from "@/lib/theme"

interface Props {
  aiName: string | null
  open: boolean
  onClose: () => void
  onNameSaved: () => void
  onLogout: () => void
}

const APPEARANCE: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "Auto", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
]

export function SidePanel({ aiName, open, onClose, onNameSaved, onLogout }: Props) {
  const name = aiName ?? ""
  const [editing, setEditing] = useState(!name)
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [appearance, setAppearance] = useState<ThemePref>(getThemePref)

  // Keep the form in step with the saved name (for example after a backup is restored)
  useEffect(() => {
    if (!editing) setDraft(name)
  }, [name, editing])

  const startEditing = () => {
    setDraft(name)
    setError("")
    setEditing(true)
  }

  const cancel = () => {
    setDraft(name)
    setError("")
    setEditing(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const problem = validateAiName(draft)
    if (problem) {
      setError(problem)
      return
    }
    setError("")
    setSaving(true)
    try {
      await setAiName(draft)
      setEditing(false)
      onNameSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the name.")
    } finally {
      setSaving(false)
    }
  }

  const chooseAppearance = (value: ThemePref) => {
    setAppearance(value)
    setThemePref(value)
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={
          "fixed inset-y-0 left-0 z-40 flex w-[19rem] flex-col border-r border-[var(--chat-border)] bg-[var(--chat-bg-sidebar)] backdrop-blur-2xl backdrop-saturate-150 transition-transform duration-300 md:static md:z-auto md:translate-x-0 " +
          (open ? "translate-x-0" : "-translate-x-full")
        }
        aria-label="Settings"
      >
        <div className="flex items-center justify-between px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-2">
          <span className="font-display zeneb-gradient-text text-[1.6rem] leading-none font-semibold">
            Dear Zeneb
          </span>
          <button
            onClick={onClose}
            className="rounded-xl p-1.5 text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)] md:hidden"
            aria-label="Close panel"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
          <div className="zeneb-avatar flex size-20 items-center justify-center rounded-full text-[32px] font-semibold">
            {(name || "?").charAt(0).toUpperCase()}
          </div>

          {editing ? (
            <form onSubmit={save} className="mt-5 flex w-full flex-col gap-2 text-left">
              <label
                htmlFor="ai-name"
                className="text-[13px] font-medium text-[var(--chat-text-secondary)]"
              >
                {name ? "Rename your friend" : "What would you like to call me?"}
              </label>
              <input
                id="ai-name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={40}
                autoFocus={!name}
                placeholder="Pick any name"
                className="zeneb-input w-full rounded-2xl px-4 py-3 text-[15px] text-[var(--chat-text-primary)] placeholder:text-[var(--chat-text-tertiary)]"
              />
              {error && (
                <p role="alert" className="text-[12px] text-red-500">
                  {error}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="zeneb-btn flex-1 rounded-2xl px-3 py-2.5 text-[14px] font-semibold"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                {name && (
                  <button
                    type="button"
                    onClick={cancel}
                    className="rounded-2xl border border-[var(--chat-border-strong)] px-4 py-2.5 text-[14px] text-[var(--chat-text-secondary)] hover:bg-[var(--chat-accent-soft)]"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          ) : (
            <>
              <p className="font-display mt-5 text-[1.5rem] leading-tight font-semibold text-[var(--chat-text-primary)]">
                {name}
              </p>
              <p className="mt-1 text-[12px] tracking-wide text-[var(--chat-text-tertiary)] uppercase">
                Your friend
              </p>
              <button
                onClick={startEditing}
                className="mt-4 flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] text-[var(--chat-text-secondary)] transition-colors hover:bg-[var(--chat-accent-soft)] hover:text-[var(--chat-text-primary)]"
              >
                <Pencil className="size-3.5" />
                Change name
              </button>
            </>
          )}
        </div>

        <div className="px-6">
          <p className="mb-2 text-[12px] font-medium tracking-wide text-[var(--chat-text-tertiary)] uppercase">
            Appearance
          </p>
          <div
            role="radiogroup"
            aria-label="Appearance"
            className="grid grid-cols-3 gap-1 rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-accent-soft)] p-1"
          >
            {APPEARANCE.map(({ value, label, Icon }) => {
              const active = appearance === value
              return (
                <button
                  key={value}
                  role="radio"
                  aria-checked={active}
                  onClick={() => chooseAppearance(value)}
                  className={
                    "flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[12.5px] font-medium transition-all " +
                    (active
                      ? "bg-[var(--chat-bg-main)] text-[var(--chat-text-primary)] shadow-[var(--chat-shadow-sm)]"
                      : "text-[var(--chat-text-secondary)] hover:text-[var(--chat-text-primary)]")
                  }
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-auto px-6 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <button
            onClick={onLogout}
            className="flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] text-[var(--chat-text-secondary)] transition-colors hover:bg-[var(--chat-accent-soft)] hover:text-[var(--chat-text-primary)]"
          >
            <LogOut className="size-4" />
            Log out
          </button>
        </div>
      </aside>
    </>
  )
}
