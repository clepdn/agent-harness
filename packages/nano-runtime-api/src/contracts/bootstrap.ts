import type Database from "better-sqlite3"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"
import type { ContextImageReference } from "./images"
import type { UserMessage } from "../types"

export interface FrontendSoulStore {
  readonly viewPath: string
  readonly patchPath: string
  reconcileFrontendSoul(): Promise<FrontendSoulReconciliation>
  readFrontendSoul(): Promise<string>
  writeFrontendSoul(expectedSoul: string, content: string): Promise<{ patchPath: string; conflicted: boolean }>
}

export type FrontendSoulReconciliation = {
  soul: string
  initialized: boolean
  mainChanged: boolean
  conflicted: boolean
  recovered: boolean
  requiresFreshSession: boolean
}

export interface BootstrapHome {
  readonly home: string
  readonly db?: Database.Database
  readonly frontendSoul: FrontendSoulStore
  readonly eventImageReferences?: (event: UserMessage) => ContextImageReference[]
}

export interface PriorRestContext {
  restedAt: string
  note?: string
  forest: string
}

export type BootstrapCapabilities = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  discord?: boolean
  frontend?: boolean
  agentChannel?: boolean
  vision?: boolean
}
