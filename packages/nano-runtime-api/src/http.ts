import type { FastifyInstance } from "fastify"
import { defineSlot } from "@nano/plugins"

/** Routes contributed to the worker's existing HTTP listener before it starts. */
export type HttpRouteInstaller = (app: FastifyInstance) => void | Promise<void>
export const nanoHttpRoutes = defineSlot<HttpRouteInstaller>("nano.http-routes")
