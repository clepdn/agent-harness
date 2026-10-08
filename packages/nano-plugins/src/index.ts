export type Cleanup = () => void | Promise<void>;

export interface ServiceToken<T> {
  readonly name: string;
  /** Type-only marker; token identity is the object itself. */
  readonly __type?: T;
}

export interface SlotToken<T> {
  readonly name: string;
  /** Type-only marker; token identity is the object itself. */
  readonly __type?: T;
}

export interface EventToken<T> {
  readonly name: string;
  /** Type-only marker; token identity is the object itself. */
  readonly __type?: T;
}

export function defineService<T>(name: string): ServiceToken<T> {
  return defineToken<ServiceToken<T>>(name);
}

export function defineSlot<T>(name: string): SlotToken<T> {
  return defineToken<SlotToken<T>>(name);
}

export function defineEvent<T>(name: string): EventToken<T> {
  return defineToken<EventToken<T>>(name);
}

function defineToken<T extends { readonly name: string }>(name: string): T {
  if (!name.trim()) throw new TypeError('Plugin token name must not be empty');
  return Object.freeze({ name }) as T;
}

export interface Plugin<C = unknown> {
  readonly id: string;
  readonly requires?: readonly ServiceToken<unknown>[];
  readonly optional?: readonly ServiceToken<unknown>[];
  /** Services this plugin may publish. Required for dependency scheduling. */
  readonly provides?: readonly ServiceToken<unknown>[];
  readonly validate?: (raw: unknown) => C;
  apply(scope: PluginScope, config: C): void | Cleanup | Promise<void | Cleanup>;
}

export interface PluginScope {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly config: unknown;
  provide<T>(token: ServiceToken<T>, value: T): () => Promise<void>;
  use<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
  register<T>(slot: SlotToken<T>, key: string, value: T): () => void;
  list<T>(slot: SlotToken<T>): readonly SlotContribution<T>[];
  watch<T>(slot: SlotToken<T>, callback: (contributions: readonly SlotContribution<T>[]) => void | Promise<void>): () => void;
  on<T>(event: EventToken<T>, callback: (payload: T) => void | Promise<void>): () => void;
  emit<T>(event: EventToken<T>, payload: T): Promise<void>;
  own(cleanup: Cleanup): () => void;
  guard<F extends (...args: never[]) => unknown>(callback: F): F;
  interval(callback: () => void | Promise<void>, ms: number): () => void;
  timeout(callback: () => void | Promise<void>, ms: number): () => void;
}

export interface SlotContribution<T> {
  readonly key: string;
  readonly value: T;
  readonly owner: string;
}

export type PluginStatusName = 'PENDING' | 'LOADING' | 'ACTIVE' | 'FAILED' | 'UNLOADING' | 'DISPOSED';
export type PluginPhase = 'validate' | 'dependencies' | 'apply' | 'callback' | 'dispose';

export interface PluginError {
  readonly phase: PluginPhase;
  readonly error: unknown;
  readonly generation: number;
}

export interface PluginStatus {
  readonly id: string;
  readonly status: PluginStatusName;
  readonly phase?: PluginPhase;
  readonly error?: unknown;
  readonly errors: readonly PluginError[];
  readonly missingDeps: readonly string[];
  readonly generation: number;
}

export interface PluginInspection {
  readonly plugins: number;
  readonly services: number;
  readonly slots: number;
  readonly listeners: number;
  readonly timers: number;
  readonly byStatus: Readonly<Record<PluginStatusName, number>>;
}

export interface PluginBusOptions {
  readonly config?: unknown;
  readonly disposeTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
}
export interface PluginInstallOptions {
  readonly enabled?: boolean;
}

interface RuntimePlugin {
  readonly id: string;
  readonly requires?: readonly ServiceToken<unknown>[];
  readonly optional?: readonly ServiceToken<unknown>[];
  readonly provides?: readonly ServiceToken<unknown>[];
  readonly validate?: (raw: unknown) => unknown;
  readonly apply: (scope: PluginScope, config: unknown) => void | Cleanup | Promise<void | Cleanup>;
}

interface PluginPlan {
  readonly order: Array<{ readonly entry: PluginEntry; readonly bindings: Map<ServiceToken<unknown>, string | undefined> }>;
}
interface OwnedResource {
  active: boolean;
  detached: boolean;
  detach: () => void;
  cleanup: Cleanup;
}

interface StagedResource extends OwnedResource {
  activate: () => void;
}

interface ServiceRecord {
  readonly owner: string;
  readonly generation: number;
  readonly value: unknown;
}

interface SlotRecord {
  readonly owner: string;
  readonly value: unknown;
}

interface ListenerRecord {
  readonly owner: string;
  readonly callback: (payload: unknown) => void | Promise<void>;
}

interface SlotObserverRecord {
  readonly slot: SlotToken<unknown>;
  readonly isActive: () => boolean;
  readonly callback: (contributions: readonly SlotContribution<unknown>[]) => void | Promise<void>;
  readonly onError: (error: unknown) => void;
}

interface PluginEntry {
  plugin: RuntimePlugin;
  rawConfig: unknown;
  order: number;
  status: PluginStatusName;
  phase: PluginPhase | undefined;
  error: unknown;
  errors: PluginError[];
  missingDeps: string[];
  generation: number;
  enabled: boolean;
  needsRestart: boolean;
  blocked: 'duplicate' | 'cycle' | undefined;
  controller: AbortController | undefined;
  resources: OwnedResource[];
  bindings: Map<ServiceToken<unknown>, string | undefined>;
  withdrawnServices: Set<ServiceToken<unknown>>;
}

const noop = (): void => {};
const timeoutMarker = Symbol('timeout');
const abortMarker = Symbol('aborted');

class PluginTimeoutError extends Error {
  constructor(operation: string, milliseconds: number) {
    super(`Plugin ${operation} timed out after ${milliseconds}ms`);
    this.name = 'PluginTimeoutError';
  }
}

class DuplicateServiceError extends Error {
  constructor(token: ServiceToken<unknown>) {
    super(`Service "${token.name}" already has a provider`);
    this.name = 'DuplicateServiceError';
  }
}

class DuplicateSlotKeyError extends Error {
  constructor(slot: SlotToken<unknown>, key: string) {
    super(`Slot "${slot.name}" already contains key "${key}"`);
    this.name = 'DuplicateSlotKeyError';
  }
}

export class PluginBus {
  private readonly entries = new Map<string, PluginEntry>();
  private readonly services = new Map<ServiceToken<unknown>, ServiceRecord>();
  private readonly slots = new Map<SlotToken<unknown>, Map<string, SlotRecord>>();
  private readonly listeners = new Map<EventToken<unknown>, Set<ListenerRecord>>();
  private readonly config: unknown;
  private readonly disposeTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly slotObservers = new Map<SlotToken<unknown>, Set<SlotObserverRecord>>();
  private readonly pendingSlotNotifications = new Set<SlotToken<unknown>>();
  private readonly pendingInitialObservers = new Set<SlotObserverRecord>();
  private notificationScheduled = false;
  private boundaryDepth = 0;
  private nextOrder = 0;
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: PluginBusOptions = {}) {
    this.config = options.config;
    this.disposeTimeoutMs = boundedTimeout(options.disposeTimeoutMs, 5_000);
    this.initializeTimeoutMs = boundedTimeout(options.initializeTimeoutMs, 10_000);
  }

  install<C>(plugin: Plugin<C>, config?: unknown, options: PluginInstallOptions = {}): Promise<void> {
    return this.serialize(async () => {
      this.assertOpen();
      assertPlugin(plugin);
      if (this.entries.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is already installed`);
      const enabled = options.enabled !== false;
      const entry = makeEntry(normalizePlugin(plugin), config === undefined ? this.config : config, this.nextOrder++, enabled);
      this.entries.set(plugin.id, entry);
      if (enabled) await this.reconcile();
    });
  }
  replace<C>(plugin: Plugin<C>, config?: unknown): Promise<void> {
    const pending = this.entries.get(plugin.id);
    if (pending?.status === 'LOADING') pending.controller?.abort();
    return this.serialize(async () => {
      this.assertOpen();
      assertPlugin(plugin);
      const entry = this.requireEntry(plugin.id);
      entry.plugin = normalizePlugin(plugin);
      entry.rawConfig = config === undefined ? this.config : config;
      entry.needsRestart = entry.enabled;
      entry.blocked = undefined;
      if (entry.status !== 'ACTIVE') {
        entry.error = undefined;
        entry.phase = undefined;
        entry.status = entry.enabled ? 'PENDING' : 'DISPOSED';
        entry.missingDeps = [];
      }
      await this.reconcile();
    });
  }
  disable(id: string): Promise<void> {
    const pending = this.entries.get(id);
    this.abortEntryAndDependents(id);
    if (pending) pending.enabled = false;
    return this.serialize(async () => {
      const entry = this.requireEntry(id);
      entry.enabled = false;
      entry.needsRestart = false;
      entry.blocked = undefined;
      if (entry.status !== 'ACTIVE') {
        entry.error = undefined;
        entry.phase = undefined;
        entry.status = 'DISPOSED';
        entry.missingDeps = [];
      }
      await this.reconcile();
    });
  }

  enable(id: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.requireEntry(id);
      entry.enabled = true;
      entry.needsRestart = entry.status === 'ACTIVE';
      entry.blocked = undefined;
      if (entry.status !== 'ACTIVE') {
        entry.error = undefined;
        entry.phase = undefined;
        entry.status = 'PENDING';
      }
      await this.reconcile();
    });
  }

  retry(id: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.requireEntry(id);
      entry.enabled = true;
      entry.needsRestart = entry.status === 'ACTIVE';
      entry.blocked = undefined;
      if (entry.status !== 'ACTIVE') {
        entry.error = undefined;
        entry.phase = undefined;
        entry.status = 'PENDING';
      }
      await this.reconcile();
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closePromise ?? Promise.resolve();
    this.closing = true;
    for (const entry of this.entries.values()) {
      entry.enabled = false;
      if (entry.status === 'LOADING') entry.controller?.abort();
    }
    this.closePromise = this.serialize(async () => {
      this.closed = true;
      await this.reconcile();
      for (const entry of this.entries.values()) {
        entry.status = 'DISPOSED';
        entry.missingDeps = [];
      }
    });
    return this.closePromise;
  }


  get<T>(token: ServiceToken<T>): T {
    const service = this.services.get(token as ServiceToken<unknown>);
    if (!service) throw new Error(`Service "${token.name}" is unavailable`);
    return service.value as T;
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    return this.services.get(token as ServiceToken<unknown>)?.value as T | undefined;
  }

  list<T>(slot: SlotToken<T>): readonly SlotContribution<T>[] {
    const records = this.slots.get(slot as SlotToken<unknown>);
    if (!records) return [];
    return Array.from(records, ([key, record]) => ({ key, value: record.value as T, owner: record.owner }));
  }

  async emit<T>(event: EventToken<T>, payload: T): Promise<void> {
    const records = Array.from(this.listeners.get(event as EventToken<unknown>) ?? []);
    await Promise.all(records.map(async record => {
      try {
        await record.callback(payload);
      } catch {
        // Guarded listener wrappers retain callback failures on their owning plugin.
      }
    }));
  }

  statuses(): readonly PluginStatus[] {
    return Array.from(this.entries.values(), entry => statusSnapshot(entry));
  }

  inspect(): PluginInspection {
    const byStatus: Record<PluginStatusName, number> = {
      PENDING: 0,
      LOADING: 0,
      ACTIVE: 0,
      FAILED: 0,
      UNLOADING: 0,
      DISPOSED: 0,
    };
    for (const entry of this.entries.values()) byStatus[entry.status]++;
    let slotCount = 0;
    for (const records of this.slots.values()) slotCount += records.size;
    let listenerCount = 0;
    for (const records of this.listeners.values()) listenerCount += records.size;
    for (const records of this.slotObservers.values()) listenerCount += records.size;
    let timers = 0;
    for (const entry of this.entries.values()) {
      for (const resource of entry.resources) if (resource.active && resource instanceof TimerResource) timers++;
    }
    return {
      plugins: this.entries.size,
      services: this.services.size,
      slots: slotCount,
      listeners: listenerCount,
      timers,
      byStatus,
    };
  }

  private abortEntryAndDependents(id: string): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== 'LOADING') continue;
      if (entry.plugin.id === id || [...entry.bindings.values()].includes(id)) entry.controller?.abort();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.boundaryDepth++;
      try {
        return await operation();
      } finally {
        this.boundaryDepth--;
        this.scheduleSlotNotifications();
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private abortDependentsOfService(token: ServiceToken<unknown>, providerId = this.services.get(token)?.owner): void {
    if (!providerId) return;
    for (const entry of this.entries.values()) {
      if (entry.bindings.get(token) !== providerId) continue;
      if (entry.status === 'LOADING') entry.controller?.abort();
      else if (entry.status === 'ACTIVE') entry.needsRestart = true;
    }
  }

  private markSlotChanged(slot: SlotToken<unknown>): void {
    this.pendingSlotNotifications.add(slot);
    this.scheduleSlotNotifications();
  }

  private scheduleSlotNotifications(): void {
    if (this.boundaryDepth || this.notificationScheduled ||
        (!this.pendingSlotNotifications.size && !this.pendingInitialObservers.size)) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      if (this.boundaryDepth) {
        this.scheduleSlotNotifications();
        return;
      }
      this.flushSlotNotifications();
    });
  }

  private flushSlotNotifications(): void {
    const initial = [...this.pendingInitialObservers];
    this.pendingInitialObservers.clear();
    const changedSlots = [...this.pendingSlotNotifications];
    this.pendingSlotNotifications.clear();
    const initialSet = new Set(initial);
    const snapshots = new Map<SlotToken<unknown>, readonly SlotContribution<unknown>[]>();
    const snapshotFor = (slot: SlotToken<unknown>): readonly SlotContribution<unknown>[] => {
      let snapshot = snapshots.get(slot);
      if (!snapshot) {
        snapshot = this.list(slot);
        snapshots.set(slot, snapshot);
      }
      return snapshot;
    };

    for (const observer of initial) {
      if (observer.isActive()) this.invokeSlotObserver(observer, snapshotFor(observer.slot));
    }
    for (const slot of changedSlots) {
      const snapshot = snapshotFor(slot);
      const observers = this.slotObservers.get(slot);
      if (!observers) continue;
      for (const observer of [...observers]) {
        if (!initialSet.has(observer) && observer.isActive()) this.invokeSlotObserver(observer, snapshot);
      }
    }
    if (this.pendingSlotNotifications.size || this.pendingInitialObservers.size) this.scheduleSlotNotifications();
  }

  private invokeSlotObserver(
    observer: SlotObserverRecord,
    snapshot: readonly SlotContribution<unknown>[],
  ): void {
    try {
      const result = observer.callback(snapshot);
      if (result && typeof result.then === 'function') void Promise.resolve(result).catch(observer.onError);
    } catch (error) {
      observer.onError(error);
    }
  }


  private assertOpen(): void {
    if (this.closed || this.closing) throw new Error('Plugin bus is closed');
  }

  private requireEntry(id: string): PluginEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin "${id}" is not installed`);
    return entry;
  }

  private async reconcile(): Promise<void> {
    // Each unload/reload pass removes at least one active generation; this bound is a
    // final guard against accidental scheduler loops, not an initialization timeout.
    for (let pass = 0; pass < Math.max(8, this.entries.size * 4 + 4); pass++) {
      const plan = this.makePlan();
      const unload = this.unloadSet(plan);
      if (unload.size) {
        for (const entry of this.dependentFirst(unload)) await this.deactivate(entry);
        continue;
      }

      let changed = false;
      for (const item of plan.order) {
        const entry = item.entry;
        if (entry.status === 'ACTIVE' || entry.status === 'FAILED' || !entry.enabled) continue;
        const missing = this.missingRuntimeDependencies(entry);
        if (missing.length) {
          entry.status = 'PENDING';
          entry.phase = 'dependencies';
          entry.error = undefined;
          entry.missingDeps = missing;
          continue;
        }
        entry.needsRestart = false;
        await this.activate(entry, item.bindings);
        changed = true;
      }
      if (!changed) return;
    }
    for (const entry of this.entries.values()) {
      if (entry.status !== 'ACTIVE' && entry.status !== 'FAILED' && entry.enabled) {
        entry.status = 'FAILED';
        entry.phase = 'dependencies';
        entry.error = new Error('Plugin dependency reconciliation did not converge');
        entry.missingDeps = [];
      }
    }
  }


  private makePlan(): PluginPlan {
    const enabled = Array.from(this.entries.values()).filter(entry => entry.enabled);

    // Failures caused solely by a prior graph shape are recoverable as the graph changes.
    for (const entry of enabled) {
      if (entry.blocked) {
        entry.blocked = undefined;
        entry.status = 'PENDING';
        entry.phase = undefined;
        entry.error = undefined;
      }
    }

    const providers = new Map<ServiceToken<unknown>, PluginEntry[]>();
    for (const entry of enabled) {
      for (const token of uniqueTokens(entry.plugin.provides ?? [])) {
        const list = providers.get(token) ?? [];
        list.push(entry);
        providers.set(token, list);
      }
    }
    const selected = new Map<ServiceToken<unknown>, PluginEntry>();
    for (const [token, candidates] of providers) {
      const first = candidates[0];
      if (!first) continue;
      selected.set(token, first);
      for (const duplicate of candidates.slice(1)) {
        if (isStickyFailure(duplicate)) continue;
        if (duplicate.status !== 'ACTIVE') {
          duplicate.status = 'FAILED';
          duplicate.phase = 'dependencies';
          duplicate.error = new DuplicateServiceError(token);
          duplicate.missingDeps = [];
        }
        duplicate.blocked = 'duplicate';
      }
    }

    const dependencyEdges = new Map<PluginEntry, PluginEntry[]>();
    for (const entry of enabled) {
      const edges: PluginEntry[] = [];
      for (const token of [...(entry.plugin.requires ?? []), ...(entry.plugin.optional ?? [])]) {
        const provider = selected.get(token);
        if (provider && provider !== entry && !edges.includes(provider)) edges.push(provider);
      }
      dependencyEdges.set(entry, edges);
    }
    const cycles = findCycles(enabled, dependencyEdges);
    for (const entry of cycles) {
      if (isStickyFailure(entry)) continue;
      if (entry.status !== 'ACTIVE') {
        entry.status = 'FAILED';
        entry.phase = 'dependencies';
        entry.error = new Error(`Plugin dependency cycle includes "${entry.plugin.id}"`);
        entry.missingDeps = [];
      }
      entry.blocked = 'cycle';
    }
    const eligible = new Set(enabled.filter(entry => !isStickyFailure(entry) && !entry.blocked));
    const order: Array<{ entry: PluginEntry; bindings: Map<ServiceToken<unknown>, string | undefined> }> = [];
    const visited = new Set<PluginEntry>();
    const visit = (entry: PluginEntry): void => {
      if (visited.has(entry) || !eligible.has(entry)) return;
      visited.add(entry);
      const bindings = new Map<ServiceToken<unknown>, string | undefined>();
      for (const token of [...(entry.plugin.requires ?? []), ...(entry.plugin.optional ?? [])]) {
        const provider = selected.get(token);
        const service = this.services.get(token);
        const available = provider && eligible.has(provider) && !provider.withdrawnServices.has(token) &&
          (provider.status !== 'ACTIVE' || (service?.owner === provider.plugin.id && service.generation === provider.generation))
          ? provider : undefined;
        bindings.set(token, available?.plugin.id);
        if (available) visit(available);
      }
      order.push({ entry, bindings });
    };
    for (const entry of enabled.sort((a, b) => a.order - b.order)) visit(entry);
    for (const entry of enabled) {
      if (entry.status === 'ACTIVE' || entry.status === 'FAILED') continue;
      const missing = (entry.plugin.requires ?? []).filter(token => {
        const provider = selected.get(token);
        return !provider || !eligible.has(provider) || provider.withdrawnServices.has(token);
      }).map(token => token.name);
      entry.missingDeps = missing;
      if (missing.length) {
        entry.status = 'PENDING';
        entry.phase = 'dependencies';
        entry.error = undefined;
      } else if (entry.phase === 'dependencies') {
        entry.phase = undefined;
        entry.error = undefined;
      }
    }
    return { order };
  }

  private unloadSet(plan: PluginPlan): Set<PluginEntry> {
    const expected = new Map(plan.order.map(item => [item.entry, item.bindings]));
    const unload = new Set<PluginEntry>();
    for (const entry of this.entries.values()) {
      if (entry.status !== 'ACTIVE') continue;
      const bindings = expected.get(entry);
      if (!entry.enabled || entry.needsRestart || !bindings || !sameBindings(entry.bindings, bindings)) unload.add(entry);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of this.entries.values()) {
        if (entry.status !== 'ACTIVE' || unload.has(entry)) continue;
        if ([...entry.bindings.values()].some(providerId => {
          const provider = providerId ? this.entries.get(providerId) : undefined;
          return provider && unload.has(provider);
        })) {
          unload.add(entry);
          changed = true;
        }
      }
    }
    return unload;
  }

  private dependentFirst(unload: Set<PluginEntry>): PluginEntry[] {
    const result: PluginEntry[] = [];
    const visited = new Set<PluginEntry>();
    const visit = (provider: PluginEntry): void => {
      if (visited.has(provider)) return;
      visited.add(provider);
      for (const dependent of this.entries.values()) {
        if (dependent.status === 'ACTIVE' && unload.has(dependent) &&
            [...dependent.bindings.values()].includes(provider.plugin.id)) visit(dependent);
      }
      result.push(provider);
    };
    for (const entry of [...unload].sort((a, b) => b.order - a.order)) visit(entry);
    return result;
  }

  private missingRuntimeDependencies(entry: PluginEntry): string[] {
    const missing: string[] = [];
    for (const token of entry.plugin.requires ?? []) {
      const service = this.services.get(token);
      const provider = service ? this.entries.get(service.owner) : undefined;
      if (!service || provider?.withdrawnServices.has(token)) missing.push(token.name);
    }
    return missing;
  }

  private async activate(entry: PluginEntry, bindings: Map<ServiceToken<unknown>, string | undefined>): Promise<void> {
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    entry.resources = [];
    entry.bindings = new Map(bindings);
    entry.status = 'LOADING';
    entry.phase = undefined;
    entry.error = undefined;
    entry.missingDeps = [];

    let config: unknown;
    try {
      config = entry.plugin.validate ? entry.plugin.validate(entry.rawConfig) : entry.rawConfig;
    } catch (error) {
      this.recordError(entry, generation, 'validate', error);
      entry.status = 'FAILED';
      entry.phase = 'validate';
      entry.error = error;
      controller.abort();
      return;
    }

    const resources: StagedResource[] = [];
    const stagedServices = new Map<ServiceToken<unknown>, StagedResource>();
    const stagedSlots = new Map<SlotToken<unknown>, number>();
    const declarations = new Set(uniqueTokens(entry.plugin.provides ?? []));
    const required = new Set(entry.plugin.requires ?? []);
    const optional = new Set(entry.plugin.optional ?? []);
    const isOpen = (): boolean => !controller.signal.aborted && entry.generation === generation &&
      (entry.status === 'LOADING' || entry.status === 'ACTIVE');
    const ensureOpen = (): void => {
      if (!isOpen()) throw new Error(`Plugin "${entry.plugin.id}" scope is cancelled`);
    };
    const createResource = (activate: () => void, detach: () => void, cleanup: Cleanup = detach): StagedResource => {
      const resource: StagedResource = { active: true, detached: false, activate, detach, cleanup };
      resources.push(resource);
      entry.resources.push(resource);
      return resource;
    };
    const publishResource = (resource: StagedResource): void => {
      if (entry.status !== 'ACTIVE') return;
      try {
        resource.activate();
      } catch (error) {
        resource.active = false;
        try {
          resource.detach();
          resource.detached = true;
        } catch (detachError) {
          this.recordError(entry, generation, 'dispose', detachError);
        }
        void this.runCleanup(entry, generation, resource.cleanup, 'dispose');
        this.recordError(entry, generation, 'callback', error);
        throw error;
      }
    };
    const disposeResource = (resource: StagedResource): void => {
      if (!resource.active) return;
      resource.active = false;
      if (resource.detach && !resource.detached) {
        resource.detached = true;
        resource.detach();
      }
      void this.runCleanup(entry, generation, resource.cleanup, 'dispose');
    };
    const callbackActive = (): boolean =>
      !controller.signal.aborted && entry.generation === generation &&
      (entry.status === 'LOADING' || entry.status === 'ACTIVE');
    const callbackCancellation = (): Error => new Error(`Plugin "${entry.plugin.id}" callback scope is cancelled`);
    const invokeSafely = (callback: () => void | Promise<void>): void => {
      if (!callbackActive()) return;
      try {
        const result = callback();
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(error => {
            this.recordError(entry, generation, 'callback', error);
          });
        }
      } catch (error) {
        this.recordError(entry, generation, 'callback', error);
      }
    };
    const scope: PluginScope = {
      id: entry.plugin.id,
      signal: controller.signal,
      config,
      provide: <T>(token: ServiceToken<T>, value: T): (() => Promise<void>) => {
        const serviceToken = token as ServiceToken<unknown>;
        ensureOpen();
        if (!declarations.has(serviceToken)) throw new Error(`Plugin "${entry.plugin.id}" did not declare service "${token.name}" in provides`);
        if (stagedServices.has(serviceToken)) throw new DuplicateServiceError(serviceToken);
        const resource = createResource(
          () => {
            if (this.services.has(serviceToken)) throw new DuplicateServiceError(serviceToken);
            this.services.set(serviceToken, { owner: entry.plugin.id, generation, value });
            if (entry.status === 'ACTIVE') {
              void this.serialize(() => this.reconcile()).catch(error => this.recordError(entry, generation, 'callback', error));
            }
          },
          () => {
            if (this.services.get(serviceToken)?.owner === entry.plugin.id) this.services.delete(serviceToken);
          },
        );
        stagedServices.set(serviceToken, resource);
        publishResource(resource);
        return async () => {
          if (!resource.active) return;
          if (controller.signal.aborted || entry.generation !== generation || entry.status === 'UNLOADING') {
            await this.disposeOwnedResource(entry, generation, resource);
            stagedServices.delete(serviceToken);
            entry.withdrawnServices.delete(serviceToken);
            return;
          }
          if (this.services.get(serviceToken)?.owner !== entry.plugin.id) {
            await this.disposeOwnedResource(entry, generation, resource);
            stagedServices.delete(serviceToken);
            return;
          }
          entry.withdrawnServices.add(serviceToken);
          this.abortDependentsOfService(serviceToken, entry.plugin.id);
          await this.serialize(async () => {
            await this.reconcile();
            await this.disposeOwnedResource(entry, generation, resource);
            stagedServices.delete(serviceToken);
            entry.withdrawnServices.delete(serviceToken);
            await this.reconcile();
          });
        };
      },
      use: <T>(token: ServiceToken<T>): T => {
        if (controller.signal.aborted) throw new Error(`Plugin "${entry.plugin.id}" scope is cancelled`);
        if (!required.has(token as ServiceToken<unknown>)) throw new Error(`Plugin "${entry.plugin.id}" did not declare required service "${token.name}"`);
        const service = this.services.get(token as ServiceToken<unknown>);
        if (!service) throw new Error(`Required service "${token.name}" is unavailable to plugin "${entry.plugin.id}"`);
        return service.value as T;
      },
      optional: <T>(token: ServiceToken<T>): T | undefined => {
        if (controller.signal.aborted) throw new Error(`Plugin "${entry.plugin.id}" scope is cancelled`);
        const serviceToken = token as ServiceToken<unknown>;
        if (!optional.has(serviceToken)) throw new Error(`Plugin "${entry.plugin.id}" did not declare optional service "${token.name}"`);
        if (bindings.has(serviceToken) && bindings.get(serviceToken) === undefined) return undefined;
        return this.services.get(serviceToken)?.value as T | undefined;
      },
      register: <T>(slot: SlotToken<T>, key: string, value: T): (() => void) => {
        ensureOpen();
        if (!key.trim()) throw new TypeError('Slot contribution key must not be empty');
        const slotToken = slot as SlotToken<unknown>;
        const resource = createResource(
          () => {
            const records = this.slots.get(slotToken) ?? new Map<string, SlotRecord>();
            if (records.has(key)) throw new DuplicateSlotKeyError(slotToken, key);
            records.set(key, { owner: entry.plugin.id, value });
            this.slots.set(slotToken, records);
            stagedSlots.set(slotToken, (stagedSlots.get(slotToken) ?? 0) + 1);
            if (entry.status === 'ACTIVE') this.markSlotChanged(slotToken);
          },
          () => {
            const records = this.slots.get(slotToken);
            if (records?.get(key)?.owner === entry.plugin.id) {
              records.delete(key);
              if (!records.size) this.slots.delete(slotToken);
              const remaining = (stagedSlots.get(slotToken) ?? 1) - 1;
              if (remaining) stagedSlots.set(slotToken, remaining);
              else stagedSlots.delete(slotToken);
              if (entry.status === 'ACTIVE' || entry.status === 'UNLOADING') this.markSlotChanged(slotToken);
            }
          },
          noop,
        );
        publishResource(resource);
        return () => disposeResource(resource);
      },
      watch: <T>(slot: SlotToken<T>, callback: (contributions: readonly SlotContribution<T>[]) => void | Promise<void>): (() => void) => {
        ensureOpen();
        if (typeof callback !== 'function') throw new TypeError('Slot watcher callback must be a function');
        const slotToken = slot as SlotToken<unknown>;
        let observationActive = true;
        const observer: SlotObserverRecord = {
          slot: slotToken,
          isActive: () => observationActive && entry.enabled && callbackActive(),
          callback: callback as (contributions: readonly SlotContribution<unknown>[]) => void | Promise<void>,
          onError: error => {
            if (observationActive && entry.enabled && callbackActive()) this.recordError(entry, generation, 'callback', error);
          },
        };
        const resource = createResource(
          () => {
            const observers = this.slotObservers.get(slotToken) ?? new Set<SlotObserverRecord>();
            observers.add(observer);
            this.slotObservers.set(slotToken, observers);
            this.pendingInitialObservers.add(observer);
            this.scheduleSlotNotifications();
          },
          () => {
            observationActive = false;
            const observers = this.slotObservers.get(slotToken);
            observers?.delete(observer);
            if (!observers?.size) this.slotObservers.delete(slotToken);
            this.pendingInitialObservers.delete(observer);
          }
        );
        publishResource(resource);
        return () => disposeResource(resource);
      },
      emit: <T>(event: EventToken<T>, payload: T): Promise<void> => {
        ensureOpen();
        return this.emit(event, payload);
      },
      own: (cleanup: Cleanup): (() => void) => {
        if (typeof cleanup !== 'function') throw new TypeError('Owned cleanup must be a function');
        if (!isOpen()) {
          void this.runCleanup(entry, generation, cleanup, 'dispose');
          return noop;
        }
        const resource = createResource(noop, noop, cleanup);
        publishResource(resource);
        return () => disposeResource(resource);
      },
      list: <T>(slot: SlotToken<T>): readonly SlotContribution<T>[] => {
        if (controller.signal.aborted) throw new Error(`Plugin "${entry.plugin.id}" scope is cancelled`);
        return this.list(slot);
      },
      on: <T>(event: EventToken<T>, callback: (payload: T) => void | Promise<void>): (() => void) => {
        ensureOpen();
        const eventToken = event as EventToken<unknown>;
        const guarded = async (payload: T): Promise<void> => {
          if (!callbackActive()) return;
          try {
            await callback(payload);
          } catch (error) {
            this.recordError(entry, generation, 'callback', error);
          }
        };
        const listener: ListenerRecord = { owner: entry.plugin.id, callback: guarded as (payload: unknown) => Promise<void> };
        const resource = createResource(
          () => {
            const records = this.listeners.get(eventToken) ?? new Set<ListenerRecord>();
            records.add(listener);
            this.listeners.set(eventToken, records);
          },
          () => {
            const records = this.listeners.get(eventToken);
            records?.delete(listener);
            if (!records?.size) this.listeners.delete(eventToken);
          },
        );
        publishResource(resource);
        return () => disposeResource(resource);
      },
      guard: <F extends (...args: never[]) => unknown>(callback: F): F => {
        return ((...args: Parameters<F>): ReturnType<F> => {
          if (!callbackActive()) throw callbackCancellation();
          try {
            const result = callback(...args);
            if (result instanceof Promise) {
              return result.catch(error => {
                this.recordError(entry, generation, 'callback', error);
                throw error;
              }) as ReturnType<F>;
            }
            return result as ReturnType<F>;
          } catch (error) {
            this.recordError(entry, generation, 'callback', error);
            throw error;
          }
        }) as F;
      },
      interval: (callback: () => void | Promise<void>, ms: number): (() => void) => {
        validateTimer(ms);
        ensureOpen();
        const timer = new TimerResource(() => {
          timer.handle = globalThis.setInterval(() => invokeSafely(callback), ms);
        }, () => { if (timer.handle !== undefined) globalThis.clearInterval(timer.handle); });
        resources.push(timer);
        entry.resources.push(timer);
        publishResource(timer);
        return () => disposeResource(timer);
      },
      timeout: (callback: () => void | Promise<void>, ms: number): (() => void) => {
        validateTimer(ms);
        ensureOpen();
        const timer = new TimerResource(() => {
          timer.handle = globalThis.setTimeout(() => invokeSafely(callback), ms);
        }, () => { if (timer.handle !== undefined) globalThis.clearTimeout(timer.handle); });
        resources.push(timer);
        entry.resources.push(timer);
        publishResource(timer);
        return () => disposeResource(timer);
      },
    };

    let applyPromise: Promise<void | Cleanup>;
    try {
      applyPromise = Promise.resolve(entry.plugin.apply(scope, config));
    } catch (error) {
      applyPromise = Promise.reject(error);
    }
    const outcome = await withTimeout(applyPromise, this.initializeTimeoutMs, controller.signal);
    if (outcome === abortMarker) {
      controller.abort();
      await this.rollback(entry, generation, resources);
      void applyPromise.then(lateCleanup => {
        if (typeof lateCleanup === 'function') void this.runCleanup(entry, generation, lateCleanup, 'dispose');
      }, lateError => this.recordError(entry, generation, 'apply', lateError));
      entry.resources = [];
      entry.status = entry.enabled ? 'PENDING' : 'DISPOSED';
      entry.phase = undefined;
      entry.error = undefined;
      return;
    }
    if (outcome === timeoutMarker) {
      const error = new PluginTimeoutError('initialization', this.initializeTimeoutMs);
      controller.abort();
      entry.status = 'FAILED';
      entry.phase = 'apply';
      entry.error = error;
      this.recordError(entry, generation, 'apply', error);
      await this.rollback(entry, generation, resources);
      void applyPromise.then(lateCleanup => {
        if (typeof lateCleanup === 'function') void this.runCleanup(entry, generation, lateCleanup, 'dispose');
      }, lateError => this.recordError(entry, generation, 'apply', lateError));
      return;
    }
    if (outcome instanceof Error) {
      controller.abort();
      entry.status = 'FAILED';
      entry.phase = 'apply';
      entry.error = outcome;
      this.recordError(entry, generation, 'apply', outcome);
      await this.rollback(entry, generation, resources);
      return;
    }
    if (!isOpen()) {
      if (typeof outcome === 'function') await this.runCleanup(entry, generation, outcome, 'dispose');
      await this.rollback(entry, generation, resources);
      entry.resources = [];
      entry.status = entry.enabled ? 'PENDING' : 'DISPOSED';
      entry.phase = undefined;
      entry.error = undefined;
      return;
    }
    if (typeof outcome === 'function') createResource(noop, noop, outcome);
    try {
      for (const resource of resources) {
        if (resource.active) resource.activate();
      }
      entry.status = 'ACTIVE';
      entry.phase = undefined;
      entry.error = undefined;
      entry.missingDeps = [];
      for (const slot of stagedSlots.keys()) this.markSlotChanged(slot);
    } catch (error) {
      controller.abort();
      entry.status = 'FAILED';
      entry.phase = 'apply';
      entry.error = error;
      this.recordError(entry, generation, 'apply', error);
      await this.rollback(entry, generation, resources);
    }
  }

  private async rollback(entry: PluginEntry, generation: number, resources: StagedResource[]): Promise<void> {
    for (const resource of [...resources].reverse()) await this.runResource(entry, generation, resource);
  }

  private async disposeOwnedResource(entry: PluginEntry, generation: number, resource: OwnedResource): Promise<void> {
    await this.runResource(entry, generation, resource);
  }

  private async deactivate(entry: PluginEntry): Promise<void> {
    const generation = entry.generation;
    entry.status = 'UNLOADING';
    entry.controller?.abort();
    // Invalidate the generation before running user cleanup so late registration cannot leak.
    entry.generation++;
    const resources = entry.resources;
    entry.resources = [];
    for (const resource of [...resources].reverse()) await this.runResource(entry, generation, resource);
    entry.controller = undefined;
    entry.withdrawnServices.clear();
    entry.bindings.clear();
    entry.status = entry.enabled ? 'PENDING' : 'DISPOSED';
    entry.phase = undefined;
    entry.error = undefined;
    entry.missingDeps = [];
    entry.needsRestart = false;
  }

  private async runResource(entry: PluginEntry, generation: number, resource: OwnedResource): Promise<void> {
    if (!resource.active) return;
    resource.active = false;
    try {
      if (!resource.detached) {
        resource.detached = true;
        resource.detach();
      }
    } catch (error) {
      this.recordError(entry, generation, 'dispose', error);
    }
    await this.runCleanup(entry, generation, resource.cleanup, 'dispose');
  }

  private async runCleanup(entry: PluginEntry, generation: number, cleanup: Cleanup, phase: PluginPhase): Promise<void> {
    let result: Promise<void>;
    try {
      result = Promise.resolve(cleanup());
    } catch (error) {
      this.recordError(entry, generation, phase, error);
      return;
    }
    const outcome = await withTimeout(result, this.disposeTimeoutMs);
    if (outcome === timeoutMarker) {
      const error = new PluginTimeoutError('disposal', this.disposeTimeoutMs);
      this.recordError(entry, generation, phase, error);
      void result.catch(lateError => this.recordError(entry, generation, phase, lateError));
    } else if (outcome instanceof Error) {
      this.recordError(entry, generation, phase, outcome);
    }
  }

  private recordError(entry: PluginEntry, generation: number, phase: PluginPhase, error: unknown): void {
    entry.errors.push({ phase, error, generation });
    if (generation === entry.generation && entry.status !== 'UNLOADING') {
      entry.phase = phase;
      entry.error = error;
    }
  }
}

class TimerResource implements StagedResource {
  active = true;
  detached = false;
  handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  readonly activate: () => void;
  readonly detach: () => void;
  readonly cleanup: Cleanup;

  constructor(activate: () => void, detach: () => void) {
    this.activate = activate;
    this.detach = detach;
    this.cleanup = detach;
  }
}

function makeEntry(plugin: RuntimePlugin, rawConfig: unknown, order: number, enabled = true): PluginEntry {
  return {
    plugin,
    rawConfig,
    order,
    status: enabled ? 'PENDING' : 'DISPOSED',
    phase: undefined,
    error: undefined,
    errors: [],
    missingDeps: [],
    generation: 0,
    enabled,
    needsRestart: false,
    blocked: undefined,
    controller: undefined,
    resources: [],
    bindings: new Map(),
    withdrawnServices: new Set(),
  };
}

function assertPlugin<C>(plugin: Plugin<C>): void {
  if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string' || !plugin.id.trim()) {
    throw new TypeError('Plugin id must be a non-empty string');
  }
  if (typeof plugin.apply !== 'function') throw new TypeError(`Plugin "${plugin.id}" must provide apply(scope, config)`);
  const required = new Set(uniqueTokens(plugin.requires ?? []));
  for (const token of plugin.optional ?? []) {
    if (required.has(token)) throw new TypeError(`Plugin "${plugin.id}" declares service "${token.name}" as both required and optional`);
  }
  uniqueTokens(plugin.provides ?? []);
}

function normalizePlugin<C>(plugin: Plugin<C>): RuntimePlugin {
  return {
    id: plugin.id,
    ...(plugin.requires === undefined ? {} : { requires: plugin.requires }),
    ...(plugin.optional === undefined ? {} : { optional: plugin.optional }),
    ...(plugin.provides === undefined ? {} : { provides: plugin.provides }),
    ...(plugin.validate === undefined ? {} : { validate: (raw: unknown) => plugin.validate!(raw) }),
    apply: (scope, config) => plugin.apply(scope, config as C),
  };
}

function uniqueTokens<T extends { readonly name: string }>(tokens: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const token of tokens) {
    if (!token || typeof token.name !== 'string') throw new TypeError('Plugin dependency must be a token');
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

function isStickyFailure(entry: PluginEntry): boolean {
  return entry.status === 'FAILED' && !entry.blocked;
}

function findCycles(entries: PluginEntry[], edges: Map<PluginEntry, PluginEntry[]>): Set<PluginEntry> {
  const state = new Map<PluginEntry, 0 | 1 | 2>();
  const stack: PluginEntry[] = [];
  const cycles = new Set<PluginEntry>();
  const visit = (entry: PluginEntry): void => {
    state.set(entry, 1);
    stack.push(entry);
    for (const dependency of edges.get(entry) ?? []) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) visit(dependency);
      else if (dependencyState === 1) {
        const start = stack.lastIndexOf(dependency);
        for (const member of stack.slice(start)) cycles.add(member);
      }
    }
    stack.pop();
    state.set(entry, 2);
  };
  for (const entry of entries) if (!state.has(entry)) visit(entry);
  return cycles;
}

function sameBindings(
  actual: Map<ServiceToken<unknown>, string | undefined>,
  expected: Map<ServiceToken<unknown>, string | undefined>,
): boolean {
  if (actual.size !== expected.size) return false;
  for (const [token, provider] of expected) if (!actual.has(token) || actual.get(token) !== provider) return false;
  return true;
}

function statusSnapshot(entry: PluginEntry): PluginStatus {
  return {
    id: entry.plugin.id,
    status: entry.status,
    ...(entry.phase === undefined ? {} : { phase: entry.phase }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    errors: entry.errors.map(error => ({ ...error })),
    missingDeps: [...entry.missingDeps],
    generation: entry.generation,
  };
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Plugin lifecycle timeout must be a finite non-negative number');
  return value;
}

function validateTimer(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Timer delay must be a finite non-negative number');
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T | typeof timeoutMarker | typeof abortMarker | Error> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<typeof timeoutMarker>(resolve => {
    timer = globalThis.setTimeout(() => resolve(timeoutMarker), milliseconds);
  });
  const aborted = signal
    ? new Promise<typeof abortMarker>(resolve => {
        const onAbort = (): void => resolve(abortMarker);
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', onAbort);
        }
      })
    : new Promise<typeof abortMarker>(() => {});
  const settled = promise.then(value => value, error => error instanceof Error ? error : new Error(String(error)));
  const result = await Promise.race([settled, timeout, aborted]);
  if (timer !== undefined) globalThis.clearTimeout(timer);
  removeAbort?.();
  return result;
}
