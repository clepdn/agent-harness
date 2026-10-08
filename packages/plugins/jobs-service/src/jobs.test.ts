import { test } from "node:test"
import assert from "node:assert/strict"
import { createJobManager } from "./jobs"

test("startJob returns immediately with a job ID", () => {
  const jobs = createJobManager(() => {})
  const jobId = jobs.startJob("test", async () => "result")
  assert.ok(jobId)
  const job = jobs.getJob(jobId)!
  assert.ok(job)
  assert.equal(job.name, "test")
  assert.equal(job.status, "running")
})

test("job completion delivers a runner event", async () => {
  let deliveredEvent: unknown
  const jobs = createJobManager((event) => { deliveredEvent = event })
  const jobId = jobs.startJob("test-complete", async () => "task completed successfully")
  const job = await jobs.waitForJob(jobId)
  assert.equal(job?.status, "completed")
  assert.equal(job?.result, "task completed successfully")
  assert.ok(deliveredEvent && typeof deliveredEvent === "object")
  assert.equal("source" in deliveredEvent && deliveredEvent.source, "job")
  assert.match("content" in deliveredEvent && typeof deliveredEvent.content === "string" ? deliveredEvent.content : "", /task completed successfully/)
})

test("job stdout is captured incrementally and supports bounded ranges", async () => {
  const jobs = createJobManager(() => {})
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const jobId = jobs.startJob("streaming", async (_signal, onStdout) => {
    onStdout("alpha")
    onStdout("-beta-gamma")
    await held
    return "alpha-beta-gamma"
  })
  assert.equal(jobs.getJob(jobId)?.stdout, "alpha-beta-gamma")
  assert.deepEqual(jobs.readJobStdout(jobId, 0, 5), {
    id: jobId,
    stdoutLength: 16,
    start: 0,
    end: 5,
    stdout: "alpha",
    truncated: false,
  })
  assert.deepEqual(jobs.readJobStdout(jobId, 6, undefined, 4), {
    id: jobId,
    stdoutLength: 16,
    start: 6,
    end: 10,
    stdout: "beta",
    truncated: true,
    nextStart: 10,
  })
  finish()
  await jobs.waitForJob(jobId)
  assert.equal(jobs.getJob(jobId)?.stdout, "alpha-beta-gamma")
})

test("completed jobs without streamed chunks expose their result as stdout", async () => {
  const jobs = createJobManager(() => {})
  const jobId = jobs.startJob("non-streaming", async () => "finished output")
  await jobs.waitForJob(jobId)
  assert.equal(jobs.readJobStdout(jobId).stdout, "finished output")
  assert.throws(() => jobs.readJobStdout(jobId, 4, 3), /end must be greater than or equal to start/)
})

test("job failure delivers error details", async () => {
  let deliveredEvent: unknown
  const jobs = createJobManager((event) => { deliveredEvent = event })
  const jobId = jobs.startJob("test-fail", async () => { throw new Error("task exploded") })
  const job = await jobs.waitForJob(jobId)
  assert.equal(job?.status, "failed")
  assert.equal(job?.error, "task exploded")
  assert.ok(deliveredEvent && typeof deliveredEvent === "object")
  assert.match("content" in deliveredEvent && typeof deliveredEvent.content === "string" ? deliveredEvent.content : "", /task exploded/)
})

test("getRunningJobs returns only running jobs", async () => {
  const jobs = createJobManager(() => {})
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const slowId = jobs.startJob("slow", async () => { await held; return "done" })
  jobs.startJob("fast", async () => "done")
  await jobs.waitForJob(jobs.listJobs().find((job) => job.id !== slowId)!.id)
  assert.deepEqual(jobs.getRunningJobs().map((job) => job.id), [slowId])
  finish()
  await jobs.waitForJob(slowId)
  assert.equal(jobs.getRunningJobs().length, 0)
})

test("clearFinishedJobs removes settled jobs", async () => {
  const jobs = createJobManager(() => {})
  const id = jobs.startJob("temp", async () => "done")
  await jobs.waitForJob(id)
  assert.equal(jobs.getJob(id)?.status, "completed")
  jobs.clearFinishedJobs()
  assert.equal(jobs.getJob(id), undefined)
})

test("cancelRunningJobs aborts active work without delivering a completion event", async () => {
  const delivered: unknown[] = []
  const jobs = createJobManager((event) => { delivered.push(event) })
  let observedAbort = false
  const id = jobs.startJob("cancel-me", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { observedAbort = true; resolve() }, { once: true }))
    throw signal.reason
  })
  assert.equal(jobs.cancelRunningJobs("test discard"), 1)
  await jobs.drain()
  assert.equal(observedAbort, true)
  assert.equal(jobs.getJob(id)?.status, "cancelled")
  assert.equal(jobs.getRunningJobs().length, 0)
  assert.deepEqual(delivered, [])
})

test("foreground jobs that finish before the limit do not send a background notification", async () => {
  const delivered: unknown[] = []
  const jobs = createJobManager((event) => { delivered.push(event) })
  const outcome = await jobs.runJobUntilDetached("quick-shell", async () => "quick output", undefined, 100)
  assert.equal(outcome.detached, false)
  if (outcome.detached) return
  assert.equal(outcome.job.status, "completed")
  assert.equal(outcome.job.result, "quick output")
  assert.deepEqual(delivered, [])
  assert.equal(jobs.forgetJob(outcome.job.id), true)
})

test("foreground jobs detach and notify when they later complete", async () => {
  const delivered: unknown[] = []
  const jobs = createJobManager((event) => { delivered.push(event) })
  let finish!: (value: string) => void
  const task = new Promise<string>((resolve) => { finish = resolve })
  const outcome = await jobs.runJobUntilDetached("slow-shell", async () => task, undefined, 10)
  assert.equal(outcome.detached, true)
  if (!outcome.detached) return
  assert.equal(jobs.getJob(outcome.jobId)?.status, "running")
  finish("late output")
  const settled = await jobs.waitForJob(outcome.jobId)
  assert.equal(settled?.status, "completed")
  assert.equal(delivered.length, 1)
  const message = delivered[0]
  assert.ok(message && typeof message === "object")
  assert.match("content" in message && typeof message.content === "string" ? message.content : "", /late output/)
})

test("cancelJob aborts one job and reports invalid cancellation attempts", async () => {
  const jobs = createJobManager(() => {})
  let observedAbort = false
  const id = jobs.startJob("specific", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { observedAbort = true; resolve() }, { once: true }))
    throw signal.reason
  })
  assert.equal(jobs.cancelJob("missing"), "not-found")
  assert.equal(jobs.cancelJob(id, "stop this one"), "cancelled")
  await jobs.drain()
  assert.equal(observedAbort, true)
  assert.equal(jobs.getJob(id)?.status, "cancelled")
  assert.equal(jobs.cancelJob(id), "not-running")
})

test("independent managers own disjoint job registries and drain after cancellation", async () => {
  const first = createJobManager(() => {})
  const second = createJobManager(() => {})
  let release!: () => void
  const task = new Promise<void>((resolve) => { release = resolve })
  const id = first.startJob("isolated", async () => { await task; return "done" })
  assert.equal(second.getJob(id), undefined)
  first.cancelRunningJobs("test shutdown")
  let drained = false
  const drain = first.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  release()
  await drain
  assert.equal(drained, true)
})
