// Zeneb's local time (Lahore, UTC+5, no daylight saving), formatted without any locale dependence.
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const LAHORE_OFFSET_MS = 5 * 60 * 60 * 1000

const pad = (n: number) => String(n).padStart(2, "0")

export function lahoreTimeLine(now: Date = new Date()): string {
  // Shift the instant by +5h, then read it with the UTC getters.
  const local = new Date(now.getTime() + LAHORE_OFFSET_MS)
  const day = DAYS[(local.getUTCDay() + 6) % 7] // getUTCDay: 0 = Sunday
  return (
    `Current time where Zeneb is (Lahore): ${day} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ` +
    `${local.getUTCFullYear()}, ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}.`
  )
}
