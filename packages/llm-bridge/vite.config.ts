import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(PACKAGE_DIR, "admin"),
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: path.join(PACKAGE_DIR, "dist", "admin"),
    emptyOutDir: true,
  },
})
