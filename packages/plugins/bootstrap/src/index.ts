import type { Plugin, CordisContext } from "@nano/plugins"
import { buildBootstrap, createBootstrapHome, ensureSoulFilePlacement } from "@nano/runtime-api/bootstrap"
import { findService, getService, nano, type BootstrapService } from "@nano/runtime-api"
import type { UserMessage } from "@nano/runtime-api/types"

export function createBootstrapPlugin(): Plugin.Object {
  return {
    name: "nano.bootstrap",
    provide: "nano.bootstrap",
    inject: ["nano.persistence"],
    apply(ctx: CordisContext) {
      const persistence = getService(ctx, nano.persistence)
      const home = {
        ...createBootstrapHome(persistence.home, persistence.getDb()),
        eventImageReferences: (event: UserMessage) => findService(ctx, nano.discord)?.discordEventImageReferences(event) ?? [],
      }
      const service: BootstrapService = {
        build: (event, priorRest, options) => buildBootstrap(event, priorRest, options, home),
        ensureSoulFilePlacement: () => ensureSoulFilePlacement(home),
        reconcileFrontendSoul: () => home.frontendSoul.reconcileFrontendSoul(),
        readFrontendSoul: () => home.frontendSoul.readFrontendSoul(),
        writeFrontendSoul: (expectedSoul, content) => home.frontendSoul.writeFrontendSoul(expectedSoul, content),
      }
      ctx.provide(nano.bootstrap.name, service)
    },
  }
}

export const bootstrapPlugin = createBootstrapPlugin()
