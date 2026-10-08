import type { DiscordMessageTarget } from "../types"

export const DISCORD_TARGET_CAPACITY = 16

export type DiscordTargetRegistration = {
  targets: DiscordMessageTarget[]
  incomingTargets: DiscordMessageTarget[]
}

function normalized(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

function latest(targets: readonly DiscordMessageTarget[]): DiscordMessageTarget | null {
  return targets.reduce<DiscordMessageTarget | null>((selected, target) => {
    if (!selected) return target
    const selectedAt = Date.parse(selected.createdAt ?? "")
    const targetAt = Date.parse(target.createdAt ?? "")
    if (Number.isFinite(selectedAt) && Number.isFinite(targetAt)) return targetAt >= selectedAt ? target : selected
    return target
  }, null)
}

/** Resolve an ordinal or content prefix within the rolling Discord target registry. */
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
  const byFriendlyId = targets.find((target) => normalized(target.friendlyId) === prefix)
  if (byFriendlyId) return byFriendlyId
  const matches = targets.filter((target) => normalized(target.content).startsWith(prefix))
  return latest(matches)
}

export function hasDiscordTargetSelector(selector: unknown): boolean {
  return selector !== undefined && selector !== null && normalized(selector) !== ""
}

function targetSlot(position: number): number {
  return ((position - 1) % DISCORD_TARGET_CAPACITY) + 1
}

function normalizeRegistry(targets: readonly DiscordMessageTarget[]): DiscordMessageTarget[] {
  const registry: DiscordMessageTarget[] = []
  for (const target of targets) {
    const position = targetSlot(target.position)
    const next = { ...target, position }
    const existingIndex = registry.findIndex(
      (candidate) => candidate.position === position || candidate.messageId === target.messageId,
    )
    if (existingIndex >= 0) registry.splice(existingIndex, 1)
    registry.push(next)
  }
  return registry.slice(-DISCORD_TARGET_CAPACITY)
}

/**
 * Adds newly surfaced messages to the runner-wide rolling target registry.
 *
 * Slots advance from 1 through 16 across Discord events, then wrap and replace
 * the oldest occupant of that slot. Re-surfacing a message that is still in
 * the registry preserves its existing slot.
 */
export function registerDiscordTargets(
  current: readonly DiscordMessageTarget[],
  incoming: readonly DiscordMessageTarget[],
): DiscordTargetRegistration {
  const targets = normalizeRegistry(current)
  const incomingTargets: DiscordMessageTarget[] = []
  let cursor = targets.at(-1)?.position ?? 0

  for (const target of incoming) {
    const existingIndex = targets.findIndex((candidate) => candidate.messageId === target.messageId)
    if (existingIndex >= 0) {
      const existing = targets[existingIndex]!
      const updated = { ...target, position: existing.position }
      targets[existingIndex] = updated
      incomingTargets.push(updated)
      continue
    }

    cursor = (cursor % DISCORD_TARGET_CAPACITY) + 1
    const registered = { ...target, position: cursor }
    const occupiedIndex = targets.findIndex((candidate) => candidate.position === cursor)
    if (occupiedIndex >= 0) targets.splice(occupiedIndex, 1)
    targets.push(registered)
    incomingTargets.push(registered)
  }

  return { targets, incomingTargets }
}

/** Rewrites event-local target labels to their rolling registry slots. */
export function rewriteDiscordTargetLabels(
  content: string,
  before: readonly DiscordMessageTarget[],
  after: readonly DiscordMessageTarget[],
): string {
  const remapped = new Map<number, number>()
  for (let index = 0; index < before.length; index += 1) {
    const original = before[index]
    const registered = after[index]
    if (original && registered) remapped.set(original.position, registered.position)
  }
  return content.replace(/(\btarget:\s*)(\d+)\b/g, (match, prefix: string, rawPosition: string) => {
    const position = remapped.get(Number(rawPosition))
    return position === undefined ? match : `${prefix}${position}`
  })
}
