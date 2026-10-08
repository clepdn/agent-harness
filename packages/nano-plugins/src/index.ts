import { Context, Fiber, Service } from "@deepseek-ai/cordis"
import type { Plugin as CordisPlugin } from "@deepseek-ai/cordis"

export { Context as CordisContext, Fiber, Service }
export type { Plugin, FiberState, Inject } from "@deepseek-ai/cordis"

export type Cleanup = () => void | Promise<void>

export interface ServiceToken<T> {
  readonly name: string
  readonly __type?: T
}

export interface SlotToken<T> {
  readonly name: string
  readonly __type?: T
}

export interface EventToken<T> {
  readonly name: string
  readonly __type?: T
}

export interface SlotContribution<T> {
  readonly key: string
  readonly value: T
  readonly owner: string
}

export function defineService<T>(name: string): ServiceToken<T> {
  return defineToken<ServiceToken<T>>(name)
}

export function defineSlot<T>(name: string): SlotToken<T> {
  return defineToken<SlotToken<T>>(name)
}

export function defineEvent<T>(name: string): EventToken<T> {
  return defineToken<EventToken<T>>(name)
}

function defineToken<T extends { readonly name: string }>(name: string): T {
  return Object.freeze({ name }) as T
}

export function getService<T>(ctx: Context, token: ServiceToken<T>): T {
  const service = ctx.get(token.name) as T | undefined
  if (service === undefined) throw new Error(`Required service "${token.name}" is not available`)
  return service
}

export function findService<T>(ctx: Context, token: ServiceToken<T>): T | undefined {
  return ctx.get(token.name) as T | undefined
}

const CONTRIBUTIONS_NAME = "nano.contributions"
const CONTRIBUTIONS_TOKEN = defineService<Contributions>(CONTRIBUTIONS_NAME)
const ACTIVE_FIBER_STATE = 2

type Entry<T> = {
  readonly contribution: SlotContribution<T>
  readonly fiber: Fiber
}

type Watcher<T> = {
  readonly slot: string
  readonly ctx: Context
  readonly callback: (contributions: readonly SlotContribution<T>[]) => void | Promise<void>
  last: readonly Entry<T>[]
}

/** Keyed contributions whose visibility follows the native owner Fiber state. */
export class Contributions extends Service {
  private readonly entries = new Map<string, Map<string, Entry<unknown>>>()
  private readonly watchers = new Set<Watcher<unknown>>()

  constructor(ctx: Context) {
    super(ctx, CONTRIBUTIONS_NAME)
    ctx.on("internal/status", () => this.refreshWatchers(), { global: true })
  }

  register<T>(ctx: Context, slot: SlotToken<T>, key: string, value: T): Cleanup {
    return ctx.effect(() => {
      let entries = this.entries.get(slot.name)
      if (!entries) this.entries.set(slot.name, entries = new Map())
      if (entries.has(key)) throw new Error(`Contribution "${key}" is already registered in slot "${slot.name}"`)

      const entry: Entry<T> = {
        contribution: Object.freeze({ key, value, owner: ctx.fiber.name }),
        fiber: ctx.fiber,
      }
      entries.set(key, entry as Entry<unknown>)
      this.refreshWatchers(slot.name)

      return () => {
        if (entries!.get(key) !== entry) return
        entries!.delete(key)
        if (entries!.size === 0) this.entries.delete(slot.name)
        this.refreshWatchers(slot.name)
      }
    }, `nano.contributions(${slot.name}:${key})`)
  }

  list<T>(slot: SlotToken<T>): readonly SlotContribution<T>[] {
    return this.visibleEntries<T>(slot.name).map((entry) => entry.contribution)
  }

  watch<T>(ctx: Context, slot: SlotToken<T>, callback: Watcher<T>["callback"]): Cleanup {
    return ctx.effect(() => {
      const watcher: Watcher<T> = {
        slot: slot.name,
        ctx,
        callback,
        last: this.visibleEntries<T>(slot.name),
      }
      this.watchers.add(watcher as Watcher<unknown>)
      this.notify(watcher)
      return () => this.watchers.delete(watcher as Watcher<unknown>)
    }, `nano.watch(${slot.name})`)
  }

  private visibleEntries<T>(slot: string): readonly Entry<T>[] {
    const entries = this.entries.get(slot)
    if (!entries) return []
    const visible: Entry<T>[] = []
    for (const entry of entries.values()) {
      if (entry.fiber.state === ACTIVE_FIBER_STATE) visible.push(entry as Entry<T>)
    }
    return visible
  }

  private refreshWatchers(slot?: string): void {
    for (const watcher of this.watchers) {
      if (slot !== undefined && watcher.slot !== slot) continue
      const current = this.visibleEntries(watcher.slot)
      if (sameEntries(watcher.last, current)) continue
      watcher.last = current
      this.notify(watcher)
    }
  }

  private notify<T>(watcher: Watcher<T>): void {
    try {
      const result = watcher.callback(watcher.last.map((entry) => entry.contribution))
      if (result && typeof result.then === "function") {
        void result.catch((error) => this.reportWatcherError(watcher, error))
      }
    } catch (error) {
      this.reportWatcherError(watcher, error)
    }
  }

  private reportWatcherError<T>(watcher: Watcher<T>, error: unknown): void {
    watcher.ctx.logger.error("nano contribution watcher for %s failed: %s", watcher.slot, error)
  }
}

function sameEntries<T>(left: readonly Entry<T>[], right: readonly Entry<T>[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export function listContributions<T>(ctx: Context, slot: SlotToken<T>): readonly SlotContribution<T>[] {
  return findService(ctx, CONTRIBUTIONS_TOKEN)?.list(slot) ?? []
}

export function registerContribution<T>(ctx: Context, slot: SlotToken<T>, key: string, value: T): Cleanup {
  return getService(ctx, CONTRIBUTIONS_TOKEN).register(ctx, slot, key, value)
}


export function watchContributions<T>(
  ctx: Context,
  slot: SlotToken<T>,
  callback: (contributions: readonly SlotContribution<T>[]) => void | Promise<void>,
): Cleanup {
  return getService(ctx, CONTRIBUTIONS_TOKEN).watch(ctx, slot, callback)
}

export function onEvent<T>(ctx: Context, event: EventToken<T>, callback: (payload: T) => void): () => boolean {
  const on = ctx.on as unknown as (name: string, listener: (payload: T) => void) => () => boolean
  return on.call(ctx, event.name, callback)
}

export function emitEvent<T>(ctx: Context, event: EventToken<T>, payload: T): Promise<void> {
  const parallel = ctx.parallel as unknown as (name: string, payload: T) => Promise<void>
  return parallel.call(ctx, event.name, payload)
}

export function configSchema<C>(parser: (value: unknown) => C): NonNullable<CordisPlugin.Object<C>["Config"]> {
  return {
    "~standard": {
      version: 1,
      vendor: "nano",
      validate(value: unknown) {
        try {
          return { value: parser(value) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  } as NonNullable<CordisPlugin.Object<C>["Config"]>
}
