// Light / dark preference: "system" follows the device, the other two force a mode.
export type ThemePref = "system" | "light" | "dark"

const KEY = "zeneb_lite_theme"

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0a14" : "#fbf7ff")
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    /* storage blocked: the choice just will not survive a reload */
  }
  applyTheme(pref)
}
