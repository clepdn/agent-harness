import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const require = createRequire(import.meta.url)
const tsxLoader = require.resolve("tsx")
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const baseConfig = path.join(repoRoot, "test-config.toml")

type PromiseResolverSet<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers<T>(): PromiseResolverSet<T>
}

// Node provides Promise.withResolvers even though this project targets an older TypeScript lib.
const promiseConstructor = Promise as PromiseConstructorWithResolvers

function runChild(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<{ stdout: string; stderr: string }>()
  const child = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk })
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk })
  child.once("error", reject)
  child.once("close", (code, signal) => {
    if (code === 0) {
      resolve({ stdout, stderr })
    } else {
      reject(new Error(`child exited with ${signal ?? code}: ${stderr || stdout}`))
    }
  })
  return promise
}

async function imageRootForChild(cwd: string, configPath: string, home: string): Promise<string> {
  const configUrl = new URL("./config.ts", import.meta.url).href
  const result = await runChild(
    `import { IMAGE_ROOT } from ${JSON.stringify(configUrl)}; process.stdout.write(IMAGE_ROOT)`,
    cwd,
    { ...process.env, NANO_CONFIG: configPath, HOME: home, NANO_HOME: home },
  )
  return result.stdout.trim()
}

test("local image root follows NANO_HOME when cwd is store-like", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-image-root-"))
  const home = path.join(root, "durable-home")
  const storeCwd = path.join(root, "nix-store", "nano")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(storeCwd, { recursive: true })
  await fs.chmod(storeCwd, 0o555)
  t.after(async () => {
    await fs.chmod(storeCwd, 0o700).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  })

  const imageRoot = await imageRootForChild(storeCwd, baseConfig, home)
  assert.equal(imageRoot, path.join(home, "images"))
  assert.notEqual(imageRoot, path.join(storeCwd, "home", "images"))
})

test("explicit image_tool root remains unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-image-root-explicit-"))
  const home = path.join(root, "durable-home")
  const storeCwd = path.join(root, "nix-store", "nano")
  const configPath = path.join(root, "config.toml")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(storeCwd, { recursive: true })
  await fs.writeFile(configPath, '[image_tool]\nroot = "/srv/nano-images"\n')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  assert.equal(await imageRootForChild(storeCwd, configPath, home), "/srv/nano-images")
})

test("Docker image root keeps its container path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-image-root-docker-"))
  const home = path.join(root, "durable-home")
  const storeCwd = path.join(root, "nix-store", "nano")
  const configPath = path.join(root, "config.toml")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(storeCwd, { recursive: true })
  await fs.writeFile(configPath, '[container]\nname = "nano"\nuser = "nano"\n')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  assert.equal(await imageRootForChild(storeCwd, configPath, home), "/home/nano/images")
})
