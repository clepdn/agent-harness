import type { Plugin } from "@nano/plugins"
import { createJobManager } from "./jobs"
import { emitEvent, nano } from "@nano/runtime-api"
import type { JobsService } from "@nano/runtime-api"

export const jobsServicePlugin: Plugin = {
  name: "nano.jobs",
  provide: nano.jobs.name,
  apply(ctx) {
    const manager = createJobManager((event) => emitEvent(ctx, nano.wake, { event }))
    const service: JobsService = {
      cancelRunningJobs: (reason) => manager.cancelRunningJobs(reason),
      hasExecutingJobs: () => manager.hasExecutingJobs(),
      cancelJob: (jobId, reason) => manager.cancelJob(jobId, reason),
      forgetJob: (jobId) => manager.forgetJob(jobId),
      getJob: (jobId) => manager.getJob(jobId),
      listJobs: () => manager.listJobs(),
      readJobStdout: (jobId, start, end, maxChars) => manager.readJobStdout(jobId, start, end, maxChars),
      runJobUntilDetached: (name, task, signal, detachAfterMs) => manager.runJobUntilDetached(name, task, signal, detachAfterMs),
      startJob: (name, task, options) => manager.startJob(name, task, options),
    }
    ctx.provide(nano.jobs.name, service)
    return async () => {
      manager.cancelRunningJobs("jobs plugin stopped")
      await manager.drain()
    }
  },
}
export { createJobManager } from "./jobs"
