import { randomUUID } from "node:crypto"
import type { UserMessage } from "../types"

export interface Job {
  id: string
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  /** Incrementally captured combined shell output, or the completed result for non-shell jobs. */
  stdout: string
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
}

export type StartJobOptions = {
  /** Deliver a runner event when the job settles. Background jobs default to true. */
  notifyOnCompletion?: boolean
}

export type CancelJobResult = "cancelled" | "not-found" | "not-running"

export type ForegroundJobOutcome =
  | { detached: true; jobId: string }
  | { detached: false; job: Job }

export type JobStdoutSlice = {
  id: string
  stdoutLength: number
  start: number
  end: number
  stdout: string
  truncated: boolean
  nextStart?: number
}

export type JobTask = (signal: AbortSignal, onStdout: (chunk: string) => void) => Promise<string>
export type DeliverFn = (event: UserMessage) => void | Promise<void>

/** A job registry isolated to one plugin generation. */
export interface JobManager {
  hasExecutingJobs(): boolean
  startJob(name: string, task: JobTask, options?: StartJobOptions): string
  enableJobNotifications(jobId: string): boolean
  waitForJob(jobId: string, timeoutMs?: number): Promise<Job | null>
  runJobUntilDetached(name: string, task: JobTask, foregroundSignal: AbortSignal | undefined, detachAfterMs: number): Promise<ForegroundJobOutcome>
  cancelJob(jobId: string, reason?: string): CancelJobResult
  forgetJob(jobId: string): boolean
  cancelRunningJobs(reason?: string): number
  getJob(jobId: string): Job | undefined
  readJobStdout(jobId: string, start?: number, end?: number, maxChars?: number): JobStdoutSlice
  listJobs(): Job[]
  getRunningJobs(): Job[]
  clearFinishedJobs(): void
  /** Resolve only once cancelled tasks and completion-event delivery have drained. */
  drain(): Promise<void>
}

export function createJobManager(deliver: DeliverFn): JobManager {
  const jobs = new Map<string, Job>()
  const controllers = new Map<string, AbortController>()
  const executions = new Map<string, Promise<void>>()
  const completions = new Map<string, Promise<Job>>()
  const completionResolvers = new Map<string, (job: Job) => void>()
  const notificationEnabled = new Set<string>()
  const notificationDelivered = new Set<string>()
  const pendingDeliveries = new Set<Promise<void>>()

  function deliverCompletion(job: Job): void {
    if (!notificationEnabled.has(job.id) || notificationDelivered.has(job.id)) return
    if (job.status !== "completed" && job.status !== "failed") return
    notificationDelivered.add(job.id)
    const failed = job.status === "failed"
    const event: UserMessage = {
      source: "job",
      content: failed
        ? `[job failed] "${job.name}" (${job.id})\n\nerror: ${job.error ?? "unknown error"}`
        : `[job completed] "${job.name}" (${job.id})\n\n${job.result ?? ""}`,
      triggeredAt: new Date().toISOString(),
      raw: { jobId: job.id, jobName: job.name },
    }
    let result: void | Promise<void>
    try {
      result = deliver(event)
    } catch (error) {
      console.error("[job] completion event delivery failed:", error)
      return
    }
    if (result) {
      let tracked!: Promise<void>
      tracked = Promise.resolve(result).catch((error) => {
        console.error("[job] completion event delivery failed:", error)
      }).finally(() => pendingDeliveries.delete(tracked))
      pendingDeliveries.add(tracked)
    }
  }

  function settleJob(job: Job, status: Job["status"], value?: string): void {
    if (job.status !== "running") return
    job.status = status
    if (status === "completed") {
      job.result = value ?? ""
      if (!job.stdout && value) job.stdout = value
    } else {
      job.error = value ?? (status === "cancelled" ? "cancelled" : "unknown error")
    }
    job.completedAt = Date.now()
    controllers.delete(job.id)
    console.log(`[job] "${job.name}" (${job.id}) ${status}${value && status !== "completed" ? `: ${value}` : ""}`)
    completionResolvers.get(job.id)?.(job)
    completionResolvers.delete(job.id)
    deliverCompletion(job)
  }

  function startJob(name: string, task: JobTask, options: StartJobOptions = {}): string {
    const id = randomUUID()
    const controller = new AbortController()
    const job: Job = { id, name, status: "running", stdout: "", startedAt: Date.now() }
    jobs.set(id, job)
    controllers.set(id, controller)
    completions.set(id, new Promise<Job>((resolve) => completionResolvers.set(id, resolve)))
    if (options.notifyOnCompletion !== false) notificationEnabled.add(id)
    console.log(`[job] "${name}" (${id}) started`)

    let running: Promise<string>
    try {
      running = task(controller.signal, (chunk) => {
        if (job.status === "running" && chunk) job.stdout += chunk
      })
    } catch (error) {
      running = Promise.reject(error)
    }
    const execution = running
      .then((result) => settleJob(job, "completed", result))
      .catch((error) => settleJob(job, "failed", error instanceof Error ? error.message : String(error)))
      .finally(() => executions.delete(id))
    executions.set(id, execution)
    return id
  }

  function enableJobNotifications(jobId: string): boolean {
    const job = jobs.get(jobId)
    if (!job) return false
    notificationEnabled.add(jobId)
    deliverCompletion(job)
    return true
  }

  async function waitForJob(jobId: string, timeoutMs?: number): Promise<Job | null> {
    const job = jobs.get(jobId)
    if (!job) return null
    if (job.status !== "running") return job
    const completion = completions.get(jobId)
    if (!completion) return job
    if (timeoutMs === undefined) return completion
    return new Promise<Job | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
      completion.then((settled) => {
        clearTimeout(timer)
        resolve(settled)
      })
    })
  }

  async function runJobUntilDetached(
    name: string,
    task: JobTask,
    foregroundSignal: AbortSignal | undefined,
    detachAfterMs: number,
  ): Promise<ForegroundJobOutcome> {
    const jobId = startJob(name, task, { notifyOnCompletion: false })
    const cancelFromForeground = () => {
      const reason = foregroundSignal?.reason instanceof Error
        ? foregroundSignal.reason.message
        : "foreground operation interrupted"
      cancelJob(jobId, reason)
    }
    if (foregroundSignal?.aborted) cancelFromForeground()
    else foregroundSignal?.addEventListener("abort", cancelFromForeground, { once: true })

    const settled = await waitForJob(jobId, detachAfterMs)
    foregroundSignal?.removeEventListener("abort", cancelFromForeground)
    if (settled) return { detached: false, job: settled }
    const current = jobs.get(jobId)
    if (current && current.status !== "running") return { detached: false, job: current }
    enableJobNotifications(jobId)
    return { detached: true, jobId }
  }

  function cancelJob(jobId: string, reason = "cancelled by agent"): CancelJobResult {
    const job = jobs.get(jobId)
    if (!job) return "not-found"
    if (job.status !== "running") return "not-running"
    const controller = controllers.get(jobId)
    settleJob(job, "cancelled", reason)
    controller?.abort(new Error(reason))
    return "cancelled"
  }

  function forgetJob(jobId: string): boolean {
    const job = jobs.get(jobId)
    if (!job || job.status === "running") return false
    jobs.delete(jobId)
    completions.delete(jobId)
    completionResolvers.delete(jobId)
    notificationEnabled.delete(jobId)
    notificationDelivered.delete(jobId)
    return true
  }

  function cancelRunningJobs(reason = "session discarded"): number {
    let cancelled = 0
    for (const job of [...jobs.values()]) {
      if (cancelJob(job.id, reason) === "cancelled") cancelled += 1
    }
    return cancelled
  }

  function getJob(jobId: string): Job | undefined {
    return jobs.get(jobId)
  }

  function readJobStdout(jobId: string, start = 0, end?: number, maxChars = 20_000): JobStdoutSlice {
    const job = jobs.get(jobId)
    if (!job) throw new Error(`job not found: ${jobId}`)
    if (!Number.isInteger(start) || start < 0) throw new Error("start must be a non-negative integer")
    if (end !== undefined && (!Number.isInteger(end) || end < 0)) throw new Error("end must be a non-negative integer")
    if (end !== undefined && end < start) throw new Error("end must be greater than or equal to start")
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000) {
      throw new Error("max_chars must be an integer from 1 to 100000")
    }
    const stdoutLength = job.stdout.length
    const boundedStart = Math.min(start, stdoutLength)
    const requestedEnd = Math.min(end ?? stdoutLength, stdoutLength)
    const boundedEnd = Math.min(Math.max(requestedEnd, boundedStart), boundedStart + maxChars)
    const truncated = boundedEnd < requestedEnd
    return {
      id: job.id,
      stdoutLength,
      start: boundedStart,
      end: boundedEnd,
      stdout: job.stdout.slice(boundedStart, boundedEnd),
      truncated,
      ...(truncated ? { nextStart: boundedEnd } : {}),
    }
  }

  function listJobs(): Job[] {
    return [...jobs.values()]
  }

  function getRunningJobs(): Job[] {
    return [...jobs.values()].filter((job) => job.status === "running")
  }

  function clearFinishedJobs(): void {
    for (const [id, job] of jobs) {
      if (job.status !== "running") {
        jobs.delete(id)
        completions.delete(id)
        completionResolvers.delete(id)
        notificationEnabled.delete(id)
        notificationDelivered.delete(id)
      }
    }
  }

  async function drain(): Promise<void> {
    while (executions.size || pendingDeliveries.size) {
      await Promise.all([...executions.values(), ...pendingDeliveries])
    }
  }

  return {
    hasExecutingJobs: () => executions.size > 0,
    startJob,
    enableJobNotifications,
    waitForJob,
    runJobUntilDetached,
    cancelJob,
    forgetJob,
    cancelRunningJobs,
    getJob,
    readJobStdout,
    listJobs,
    getRunningJobs,
    clearFinishedJobs,
    drain,
  }
}
