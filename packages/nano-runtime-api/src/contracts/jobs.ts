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
