import { test } from "node:test"
import assert from "node:assert/strict"
import {
  cancelJob,
  cancelRunningJobs,
  clearFinishedJobs,
  forgetJob,
  getJob,
  getRunningJobs,
  initJobManager,
  readJobStdout,
  runJobUntilDetached,
  startJob,
  waitForJob,
} from "./jobs"

test("startJob returns immediately with a job ID", () => {
  initJobManager(() => {})

  const jobId = startJob("test", async () => {
    return "result"
  })

  assert.ok(jobId, "should return a job ID")
  const job = getJob(jobId)!
  assert.ok(job, "job should exist in registry")
  assert.equal(job.name, "test")
  assert.equal(job!.status, "running")
})

test("job completes and delivers result", async () => {
  let deliveredEvent: any = null
  initJobManager((event) => { deliveredEvent = event })

  const jobId = startJob("test-complete", async () => {
    await new Promise(r => setTimeout(r, 50))
    return "task completed successfully"
  })

  await new Promise(r => setTimeout(r, 150))

  const job = getJob(jobId)!
  assert.equal(job!.status, "completed")
  assert.equal(job!.result, "task completed successfully")
  assert.ok(deliveredEvent, "should have delivered an event")
  assert.equal(deliveredEvent.source, "job")
  assert.ok(deliveredEvent.content.includes("task completed successfully"))
})

test("job stdout is captured incrementally and supports bounded ranges", async () => {
  initJobManager(() => {})
  let finish!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const jobId = startJob("streaming", async (_signal, onStdout) => {
    onStdout("alpha")
    onStdout("-beta-gamma")
    await held
    return "alpha-beta-gamma"
  })

  assert.equal(getJob(jobId)?.stdout, "alpha-beta-gamma")
  assert.deepEqual(readJobStdout(jobId, 0, 5), {
    id: jobId,
    stdoutLength: 16,
    start: 0,
    end: 5,
    stdout: "alpha",
    truncated: false,
  })
  assert.deepEqual(readJobStdout(jobId, 6, undefined, 4), {
    id: jobId,
    stdoutLength: 16,
    start: 6,
    end: 10,
    stdout: "beta",
    truncated: true,
    nextStart: 10,
  })

  finish()
  await waitForJob(jobId)
  assert.equal(getJob(jobId)?.stdout, "alpha-beta-gamma")
})

test("completed jobs without streamed chunks expose their result as stdout", async () => {
  initJobManager(() => {})
  const jobId = startJob("non-streaming", async () => "finished output")
  await waitForJob(jobId)
  assert.equal(readJobStdout(jobId).stdout, "finished output")
  assert.throws(() => readJobStdout(jobId, 4, 3), /end must be greater than or equal to start/)
})

test("job failure delivers error", async () => {
  let deliveredEvent: any = null
  initJobManager((event) => { deliveredEvent = event })

  const jobId = startJob("test-fail", async () => {
    await new Promise(r => setTimeout(r, 50))
    throw new Error("task exploded")
  })

  await new Promise(r => setTimeout(r, 150))

  const job = getJob(jobId)!
  assert.equal(job!.status, "failed")
  assert.equal(job!.error, "task exploded")
  assert.ok(deliveredEvent.content.includes("task exploded"))
})

test("getRunningJobs returns only running jobs", async () => {
  initJobManager(() => {})

  const id1 = startJob("slow", async () => {
    await new Promise(r => setTimeout(r, 100))
    return "done"
  })
  startJob("fast", async () => "done")

  await new Promise(r => setTimeout(r, 10))
  const running = getRunningJobs()
  assert.ok(running.some(j => j.id === id1), "slow job should be running")

  await new Promise(r => setTimeout(r, 150))
  assert.equal(getRunningJobs().length, 0, "no jobs should be running after wait")
})

test("clearFinishedJobs removes completed/failed jobs", async () => {
  initJobManager(() => {})

  const id = startJob("temp", async () => "done")
  await new Promise(r => setTimeout(r, 100))

  assert.equal(getJob(id)!.status, "completed")
  clearFinishedJobs()
  assert.equal(getJob(id), undefined, "completed job should be cleared")
})

test("cancelRunningJobs aborts active work without delivering a completion event", async () => {
  const delivered: unknown[] = []
  initJobManager((event) => { delivered.push(event) })
  let observedAbort = false
  const id = startJob("cancel-me", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      observedAbort = true
      resolve()
    }, { once: true }))
    throw signal.reason
  })

  assert.equal(cancelRunningJobs("test discard"), 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(observedAbort, true)
  assert.equal(getJob(id)?.status, "cancelled")
  assert.equal(getRunningJobs().length, 0)
  assert.deepEqual(delivered, [])
})

test("foreground jobs that finish before the limit do not send a background notification", async () => {
  const delivered: unknown[] = []
  initJobManager((event) => { delivered.push(event) })
  const outcome = await runJobUntilDetached("quick-shell", async () => "quick output", undefined, 100)
  assert.equal(outcome.detached, false)
  if (outcome.detached) return
  assert.equal(outcome.job.status, "completed")
  assert.equal(outcome.job.result, "quick output")
  assert.deepEqual(delivered, [])
  assert.equal(forgetJob(outcome.job.id), true)
})

test("foreground jobs detach at the limit and notify when they later complete", async () => {
  const delivered: any[] = []
  initJobManager((event) => { delivered.push(event) })
  let finish!: (value: string) => void
  const task = new Promise<string>((resolve) => { finish = resolve })
  const outcome = await runJobUntilDetached("slow-shell", async () => task, undefined, 10)
  assert.equal(outcome.detached, true)
  if (!outcome.detached) return
  assert.equal(getJob(outcome.jobId)?.status, "running")

  finish("late output")
  const settled = await waitForJob(outcome.jobId)
  assert.equal(settled?.status, "completed")
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].content, /late output/)
})

test("cancelJob aborts one detached job and reports invalid cancellation attempts", async () => {
  initJobManager(() => {})
  let observedAbort = false
  const id = startJob("specific", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      observedAbort = true
      resolve()
    }, { once: true }))
    throw signal.reason
  })
  assert.equal(cancelJob("missing"), "not-found")
  assert.equal(cancelJob(id, "stop this one"), "cancelled")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(observedAbort, true)
  assert.equal(getJob(id)?.status, "cancelled")
  assert.equal(cancelJob(id), "not-running")
})
