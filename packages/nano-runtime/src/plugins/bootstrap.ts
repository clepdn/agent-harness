import type { Plugin } from "@nano/plugins"
import { buildBootstrap, createBootstrapHome, ensureSoulFilePlacement, type BootstrapCapabilities, type PriorRestContext } from "../bootstrap"
import type { Message, UserMessage } from "../types"
import type { FrontendSoulReconciliation } from "../frontend-soul"
import { nano, type BootstrapService } from "./api"

export interface BootstrapApplicationService {
  build(event: UserMessage, priorRest?: PriorRestContext | null, options?: BootstrapCapabilities): Promise<Message[]>
  ensureSoulFilePlacement(): Promise<void>
  reconcileFrontendSoul(): Promise<FrontendSoulReconciliation>
  readFrontendSoul(): Promise<string>
  writeFrontendSoul(expectedSoul: string, content: string): Promise<{ patchPath: string; conflicted: boolean }>
}
/** Publishes bootstrap and frontend-soul resources for one plugin generation. */
export function createBootstrapPlugin(): Plugin {
  return {
    id: "nano.bootstrap",
    provides: [nano.bootstrap],
    requires: [nano.persistence],
    optional: [nano.discord],
    apply(scope) {
      const persistence = scope.use(nano.persistence)
      const discord = scope.optional(nano.discord)
      const home = {
        ...createBootstrapHome(persistence.home, persistence.getDb()),
        ...(discord ? { eventImageReferences: discord.discordEventImageReferences } : {}),
      }
      const service: BootstrapService = {
        build: scope.guard((event, priorRest, options) => buildBootstrap(event, priorRest, options, home)),
        ensureSoulFilePlacement: scope.guard(() => ensureSoulFilePlacement(home)),
        reconcileFrontendSoul: scope.guard(() => home.frontendSoul.reconcileFrontendSoul()),
        readFrontendSoul: scope.guard(() => home.frontendSoul.readFrontendSoul()),
        writeFrontendSoul: scope.guard((expectedSoul, content) => home.frontendSoul.writeFrontendSoul(expectedSoul, content)),
      }
      return scope.provide(nano.bootstrap, service)
    },
  }
}

export const bootstrapPlugin = createBootstrapPlugin()
