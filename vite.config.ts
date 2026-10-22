import path from "node:path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "@shared": path.resolve(__dirname, "shared") } },
  // In development the API functions run through dev-server.ts (npm run dev:api) on port 3001.
  server: { port: 3000, proxy: { "/api": "http://localhost:3001" } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], globals: false },
})
