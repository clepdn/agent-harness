import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AdminApp } from "./admin-page"
import "./admin-styles.css"

const root = document.getElementById("app")
if (!root) throw new Error("admin app root not found")

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
