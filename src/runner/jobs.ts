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
  status: "running" | "completed" | "failed"
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
}

type DeliverFn = (event: UserMessage) => void

let deliver: DeliverFn | null = null
const jobs = new Map<string, Job>()

/** Initialize the job manager with a delivery function. */
export function initJobManager(deliverFn: DeliverFn): void {
  deliver = deliverFn
}

/**
 * Start a background job. Returns the job ID immediately.
 * When the task completes (or fails), the agent is woken with the result.
 */
export function startJob(name: string, task: () => Promise<string>): string {
  const id = randomUUID()
  const job: Job = {
    id,
    name,
    status: "running",
    startedAt: Date.now(),
  }
  jobs.set(id, job)

  console.log(`[job] "${name}" (${id}) started`)

  // Run the task in the background — do not await
  task()
    .then((result) => {
      job.status = "completed"
      job.result = result
      job.completedAt = Date.now()
      console.log(`[job] "${name}" (${id}) completed`)
      deliver?.({
        source: "job",
        content: `[job completed] "${name}" (${id})\n\n${result}`,
        triggeredAt: new Date().toISOString(),
        raw: { jobId: id, jobName: name },
      })
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      job.status = "failed"
      job.error = message
      job.completedAt = Date.now()
      console.error(`[job] "${name}" (${id}) failed: ${message}`)
      deliver?.({
        source: "job",
        content: `[job failed] "${name}" (${id})\n\nerror: ${message}`,
        triggeredAt: new Date().toISOString(),
        raw: { jobId: id, jobName: name },
      })
    })

  return id
}

/** Get a job by ID. */
export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId)
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
    }
  }
}
