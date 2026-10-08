import type { Plugin, CordisContext } from "@nano/plugins"
import { createBridgeModelMetadata } from "./bridge-model-metadata"
import { config, listModelPresets } from "@nano/runtime-api/config"
import { createModelStateFactory } from "./runner/model-state"
import { createOpenAICompatibleModelProvider } from "./model/openai-compatible"
import { completeModel, registerModelProvider, streamModel } from "@nano/runtime-api/model"
import type { Model } from "@nano/runtime-api/llm"
import { getService, modelProviderResolver, nano } from "@nano/runtime-api"
import type { ModelService } from "@nano/runtime-api"

/** Model dispatch remains available when any individual provider is withdrawn. */
export const modelPlugin: Plugin.Object = {
  name: "nano.model",
  inject: ["nano.persistence", "nano.contributions"],
  provide: "nano.model",
  async apply(ctx: CordisContext) {
    const persistence = getService(ctx, nano.persistence)
    const resolver = modelProviderResolver(ctx)
    const metadata = createBridgeModelMetadata()
    const controller = new AbortController()
    ctx.effect(() => () => controller.abort(), "nano.model IO")
    const resource = await createModelStateFactory({ home: persistence.home, metadata, signal: controller.signal })
    const service: ModelService = {
      resolver: () => resolver,
      current: (runtimeKind) => resource.current(runtimeKind),
      list: () => {
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
      },
      listPresets: () => listModelPresets(),
      resolveModelSwap: (preset) => resource.resolveModelSwap(preset),
      applyModelSwap: (selection) => resource.applyModelSwap(selection),
      persistModelSwap: (selection) => resource.persistModelSwap(selection),
      persistedPreset: () => resource.persistedPreset(),
      getFastMode: () => resource.getFastMode(),
      setFastMode: (enabled) => resource.setFastMode(enabled),
      serviceTier: (model) => resource.serviceTier(model),
      complete: (model, context, options) => completeModel(model, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        providerResolver: resolver,
      }),
      stream: (model, context, options) => streamModel(model, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        providerResolver: resolver,
      }),
    }
    ctx.provide(nano.model.name, service)
  },
}

export const openAICompatiblePlugin: Plugin.Object = {
  name: "nano.model-provider",
  inject: ["nano.model", "nano.contributions"],
  apply(ctx: CordisContext) {
    const model = getService(ctx, nano.model)
    registerModelProvider(ctx, "openai-compatible", createOpenAICompatibleModelProvider(model.serviceTier))
  },
}

export * from "./settings"
export * from "./bridge-model-metadata"
export * from "./codex-fast-mode"
export * from "./model/openai-compatible"
export * from "./runner/model-state"
