import type { Plugin } from "@nano/plugins"
import { createBridgeModelMetadata } from "../bridge-model-metadata"
import { config, listModelPresets } from "../config"
import { createModelStateFactory } from "../runner/model-state"
import { completeModel, createOpenAICompatibleModelProvider, registerModelProvider, streamModel } from "../model-api"
import type { Model } from "../model-api"
import { nano, modelProviderResolver } from "./api"
import type { ModelService } from "./api"

/** Model dispatch remains available when any individual provider is withdrawn. */
export const modelPlugin: Plugin = {
  id: "nano.model",
  requires: [nano.persistence],
  provides: [nano.model],
  async apply(scope) {
    const persistence = scope.use(nano.persistence)
    const resolver = modelProviderResolver(scope)
    const metadata = createBridgeModelMetadata()
    const resource = await createModelStateFactory({ home: persistence.home, metadata, signal: scope.signal })
    scope.signal.throwIfAborted()
    const service: ModelService = {
      resolver: scope.guard(() => resolver),
      current: scope.guard((runtimeKind) => resource.current(runtimeKind)),
      list: scope.guard(() => {
        const models: Model[] = []
        const seen = new Set<string>()
        const add = (model: Model | null | undefined) => {
          if (!model) return
          const key = `${model.provider}\0${model.id}\0${model.baseUrl}`
          if (seen.has(key)) return
          seen.add(key)
          models.push(model)
        }
        const lanes = config.frontend.enable ? [resource.current(), resource.current("frontend")] : [resource.current()]
        for (const lane of lanes) { add(lane.primaryModel); add(lane.fallbackModel); add(lane.summaryModel) }
        for (const preset of listModelPresets()) add(resource.resolveModelSwap(preset).model)
        return models
      }),
      listPresets: scope.guard(() => listModelPresets()),
      resolveModelSwap: scope.guard((preset) => resource.resolveModelSwap(preset)),
      applyModelSwap: scope.guard((selection) => resource.applyModelSwap(selection)),
      persistModelSwap: scope.guard((selection) => resource.persistModelSwap(selection)),
      persistedPreset: scope.guard(() => resource.persistedPreset()),
      getFastMode: scope.guard(() => resource.getFastMode()),
      setFastMode: scope.guard((enabled) => resource.setFastMode(enabled)),
      serviceTier: scope.guard((model) => resource.serviceTier(model)),
      complete: scope.guard((model, context, options) => completeModel(model, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, scope.signal]) : scope.signal,
        providerResolver: resolver,
      })),
      stream: scope.guard((model, context, options) => streamModel(model, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, scope.signal]) : scope.signal,
        providerResolver: resolver,
      })),
    }
    const remove = await scope.provide(nano.model, service)
    return remove
  },
}

export const openAICompatiblePlugin: Plugin = {
  id: "nano.model-provider",
  requires: [nano.model],
  apply(scope) {
    const model = scope.use(nano.model)
    return registerModelProvider(scope, "openai-compatible", createOpenAICompatibleModelProvider(model.serviceTier))
  },
}
