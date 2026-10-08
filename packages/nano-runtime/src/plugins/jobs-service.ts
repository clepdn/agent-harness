import type { Plugin } from "@nano/plugins"
import { createJobManager } from "../runner/jobs"
import { nano, type JobsService } from "./api"

export const jobsServicePlugin: Plugin = {
  id: "nano.jobs",
  provides: [nano.jobs],
  apply(scope) {
    const manager = createJobManager((event) => scope.emit(nano.wake, { event }).then(() => {}))
    const service: JobsService = {
      cancelRunningJobs: scope.guard((reason) => manager.cancelRunningJobs(reason)),
      hasExecutingJobs: scope.guard(() => manager.hasExecutingJobs()),
      cancelJob: scope.guard((jobId, reason) => manager.cancelJob(jobId, reason)),
      forgetJob: scope.guard((jobId) => manager.forgetJob(jobId)),
      getJob: scope.guard((jobId) => manager.getJob(jobId)),
      listJobs: scope.guard(() => manager.listJobs()),
      readJobStdout: scope.guard((jobId, start, end, maxChars) => manager.readJobStdout(jobId, start, end, maxChars)),
      runJobUntilDetached: scope.guard((name, task, signal, detachAfterMs) => manager.runJobUntilDetached(name, task, signal, detachAfterMs)),
      startJob: scope.guard((name, task, options) => manager.startJob(name, task, options)),
    }
    const remove = scope.provide(nano.jobs, service)
    return async () => {
      manager.cancelRunningJobs("jobs plugin stopped")
      await remove()
      await manager.drain()
    }
  },
}
