import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { webUiReady } from "./ui-plugins"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")

void webUiReady.then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
