/**
 * Background job manager — allows the agent to start async tasks that
 * run in the background. When a job completes, the agent is woken
 * and notified with the result via the event loop.
 *
 * The delivery function is injected from index.ts to avoid a circular
 * dependency (index.ts → loop.ts → loop-tool-registry.ts → jobs.ts).
 */

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

type DeliverFn = (event: UserMessage) => void

let deliver: DeliverFn | null = null
const jobs = new Map<string, Job>()
const controllers = new Map<string, AbortController>()
const executingJobs = new Set<string>()

/** Cancellation status is not proof that a task stopped mutating state. */
export function hasExecutingJobs(): boolean {
  return executingJobs.size > 0
}
const completions = new Map<string, Promise<Job>>()
const completionResolvers = new Map<string, (job: Job) => void>()
const notificationEnabled = new Set<string>()
const notificationDelivered = new Set<string>()

/** Initialize the job manager with a delivery function. */
export function initJobManager(deliverFn: DeliverFn): void {
  deliver = deliverFn
}

/**
 * Start a background job. Returns the job ID immediately.
 * When the task completes (or fails), the agent is woken with the result.
 */
function deliverCompletion(job: Job): void {
  if (!notificationEnabled.has(job.id) || notificationDelivered.has(job.id)) return
  if (job.status !== "completed" && job.status !== "failed") return
  notificationDelivered.add(job.id)
  const failed = job.status === "failed"
  deliver?.({
    source: "job",
    content: failed
      ? `[job failed] "${job.name}" (${job.id})\n\nerror: ${job.error ?? "unknown error"}`
      : `[job completed] "${job.name}" (${job.id})\n\n${job.result ?? ""}`,
    triggeredAt: new Date().toISOString(),
    raw: { jobId: job.id, jobName: job.name },
  })
}

function settleJob(job: Job, status: Job["status"], value?: string): void {
  if (job.status !== "running") return
  job.status = status
  if (status === "completed") {
    job.result = value ?? ""
    if (!job.stdout && value) job.stdout = value
  }
  else job.error = value ?? (status === "cancelled" ? "cancelled" : "unknown error")
  job.completedAt = Date.now()
  controllers.delete(job.id)
  console.log(`[job] "${job.name}" (${job.id}) ${status}${value && status !== "completed" ? `: ${value}` : ""}`)
  completionResolvers.get(job.id)?.(job)
  completionResolvers.delete(job.id)
  deliverCompletion(job)
}

export function startJob(
  name: string,
  task: (signal: AbortSignal, onStdout: (chunk: string) => void) => Promise<string>,
  options: StartJobOptions = {},
): string {
  const id = randomUUID()
  const controller = new AbortController()
  const job: Job = {
    id,
    name,
    status: "running",
    stdout: "",
    startedAt: Date.now(),
  }
  jobs.set(id, job)
  controllers.set(id, controller)
  executingJobs.add(id)
  completions.set(id, new Promise<Job>((resolve) => completionResolvers.set(id, resolve)))
  if (options.notifyOnCompletion !== false) notificationEnabled.add(id)

  console.log(`[job] "${name}" (${id}) started`)

  // Run the task in the background — do not await
  let running: Promise<string>
  try {
    running = task(controller.signal, (chunk) => {
      if (job.status === "running" && chunk) job.stdout += chunk
    })
  } catch (error) {
    running = Promise.reject(error)
  }
  running
    .then((result) => {
      settleJob(job, "completed", result)
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      settleJob(job, "failed", message)
    })
    .finally(() => executingJobs.delete(id))

  return id
}

/** Enable event delivery for a job that has become detached from the foreground. */
export function enableJobNotifications(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job) return false
  notificationEnabled.add(jobId)
  deliverCompletion(job)
  return true
}

/** Wait for a job to settle, or return null when the timeout wins. */
export async function waitForJob(jobId: string, timeoutMs?: number): Promise<Job | null> {
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

/**
 * Run work in the foreground until it settles or reaches the detachment limit.
 * Before detachment, a foreground abort cancels the job; after detachment the
 * job owns its signal and continues independently.
 */
export async function runJobUntilDetached(
  name: string,
  task: (signal: AbortSignal, onStdout: (chunk: string) => void) => Promise<string>,
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

  // Completion and the detachment timer can become ready in the same event-loop
  // turn. Prefer the settled foreground result if it won that boundary race.
  const current = jobs.get(jobId)
  if (current && current.status !== "running") return { detached: false, job: current }

  enableJobNotifications(jobId)
  return { detached: true, jobId }
}

/** Cancel one running job by id. */
export function cancelJob(jobId: string, reason = "cancelled by agent"): CancelJobResult {
  const job = jobs.get(jobId)
  if (!job) return "not-found"
  if (job.status !== "running") return "not-running"
  const controller = controllers.get(jobId)
  settleJob(job, "cancelled", reason)
  controller?.abort(new Error(reason))
  return "cancelled"
}

/** Remove a settled foreground-only job from the registry. */
export function forgetJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || job.status === "running") return false
  jobs.delete(jobId)
  completions.delete(jobId)
  completionResolvers.delete(jobId)
  notificationEnabled.delete(jobId)
  notificationDelivered.delete(jobId)
  return true
}

/** Cancel every background job owned by the active runtime session. */
export function cancelRunningJobs(reason = "session discarded"): number {
  let cancelled = 0
  for (const job of [...jobs.values()]) {
    if (cancelJob(job.id, reason) === "cancelled") cancelled += 1
  }
  return cancelled
}

/** Get a job by ID. */
export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId)
}

/** Read a half-open character range from a job's captured stdout. */
export function readJobStdout(
  jobId: string,
  start = 0,
  end?: number,
  maxChars = 20_000,
): JobStdoutSlice {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`job not found: ${jobId}`)
  if (!Number.isInteger(start) || start < 0) throw new Error("start must be a non-negative integer")
  if (end !== undefined && (!Number.isInteger(end) || end < 0)) {
    throw new Error("end must be a non-negative integer")
  }
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

/** List all jobs. */
export function listJobs(): Job[] {
  return Array.from(jobs.values())
}

/** List currently running jobs. */
export function getRunningJobs(): Job[] {
  return Array.from(jobs.values()).filter((j) => j.status === "running")
}

/** Clear completed/failed jobs from memory. */
export function clearFinishedJobs(): void {
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
