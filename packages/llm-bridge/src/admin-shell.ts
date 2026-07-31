import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ADMIN_DIST_DIR = path.join(SRC_DIR, "..", "dist", "admin")
const ADMIN_INDEX = path.join(ADMIN_DIST_DIR, "index.html")

export function adminPage(): string {
  return readFileSync(ADMIN_INDEX, "utf8")
}

export function hasAdminBuild(): boolean {
  return existsSync(ADMIN_INDEX)
}
