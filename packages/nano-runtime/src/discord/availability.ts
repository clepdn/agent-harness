let available = (process.env.NANO_DISABLE_DISCORD_TOOLS ?? "").trim().toLowerCase() !== "true"

export function areDiscordToolsAvailable(): boolean {
  return available
}

export function setDiscordToolsAvailable(next: boolean): void {
  available = next && (process.env.NANO_DISABLE_DISCORD_TOOLS ?? "").trim().toLowerCase() !== "true"
}
