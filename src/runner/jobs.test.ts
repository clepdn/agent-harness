import { test } from "node:test"
import assert from "node:assert/strict"
import { initJobManager, startJob, getJob, listJobs, getRunningJobs, clearFinishedJobs } from "./jobs"

test("startJob returns immediately with a job ID", () => {
  let delivered = false
  initJobManager(() => { delivered = true })

  const jobId = startJob("test", async () => {
    return "result"
  })

  assert.ok(jobId, "should return a job ID")
  const job = getJob(jobId)
  assert.ok(job, "job should exist in registry")
  assert.equal(job.name, "test")
  assert.equal(job.status, "running")
})

test("job completes and delivers result", async () => {
  let deliveredEvent: any = null
  initJobManager((event) => { deliveredEvent = event })

  const jobId = startJob("test-complete", async () => {
    await new Promise(r => setTimeout(r, 50))
    return "task completed successfully"
  })

  await new Promise(r => setTimeout(r, 150))

  const job = getJob(jobId)
  assert.equal(job.status, "completed")
  assert.equal(job.result, "task completed successfully")
  assert.ok(deliveredEvent, "should have delivered an event")
  assert.equal(deliveredEvent.source, "job")
  assert.ok(deliveredEvent.content.includes("task completed successfully"))
})

test("job failure delivers error", async () => {
  let deliveredEvent: any = null
  initJobManager((event) => { deliveredEvent = event })

  const jobId = startJob("test-fail", async () => {
    await new Promise(r => setTimeout(r, 50))
    throw new Error("task exploded")
  })

  await new Promise(r => setTimeout(r, 150))

  const job = getJob(jobId)
  assert.equal(job.status, "failed")
  assert.equal(job.error, "task exploded")
  assert.ok(deliveredEvent.content.includes("task exploded"))
})

test("getRunningJobs returns only running jobs", async () => {
  initJobManager(() => {})

  const id1 = startJob("slow", async () => {
    await new Promise(r => setTimeout(r, 100))
    return "done"
  })
  const id2 = startJob("fast", async () => "done")

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

  assert.equal(getJob(id).status, "completed")
  clearFinishedJobs()
  assert.equal(getJob(id), undefined, "completed job should be cleared")
})
