import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"
import "./zeneb-theme.css"
import { applyTheme, getThemePref } from "@/lib/theme"

// Apply the saved light/dark choice, and follow the device while the choice is "system".
applyTheme()
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getThemePref() === "system") applyTheme()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
