import type { DiscordMessageTarget } from "../types"

function normalized(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

function latest(targets: readonly DiscordMessageTarget[]): DiscordMessageTarget | null {
  return targets.reduce<DiscordMessageTarget | null>((selected, target) => {
    if (!selected) return target
    const selectedAt = Date.parse(selected.createdAt ?? "")
    const targetAt = Date.parse(target.createdAt ?? "")
    if (Number.isFinite(selectedAt) && Number.isFinite(targetAt)) return targetAt >= selectedAt ? target : selected
    return target.position >= selected.position ? target : selected
  }, null)
}

/** Resolve an ordinal or content prefix within the active Discord event. */
export function selectDiscordTarget(
  targets: readonly DiscordMessageTarget[],
  selector?: unknown,
): DiscordMessageTarget | null {
  if (targets.length === 0) return null
  if (selector === undefined || selector === null || normalized(selector) === "") return latest(targets)

  const numeric = typeof selector === "number" ? selector : NaN
  if (Number.isSafeInteger(numeric) && numeric >= 1) {
    return targets.find((target) => target.position === numeric) ?? null
  }

  const prefix = normalized(selector)
  const matches = targets.filter((target) => normalized(target.content).startsWith(prefix))
  return latest(matches)
}

export function hasDiscordTargetSelector(selector: unknown): boolean {
  return selector !== undefined && selector !== null && normalized(selector) !== ""
}
