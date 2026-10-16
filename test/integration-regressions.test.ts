import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PoolFile,
  loadPoolFile,
  savePoolFile,
  poolFilePath,
  refreshAccount,
  forgetRemoval,
  upsertOAuthAccount,
  isAvailable,
} from "../src/core/pool.ts"
import { resolveActiveToken } from "../src/core/account.ts"

const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises")
const realReadFile = fs.readFile
const realFetch = globalThis.fetch
const log = () => {}
const jwt = (rotation: string) => `h.${Buffer.from(JSON.stringify({ sub: "integration-user", rotation })).toString("base64url")}.s`
const seed = (): PoolFile => ({
  version: 1,
  accounts: [
    { id: "oauth", access: jwt("old"), refresh: "r-old", expires: 1, source: "oauth", addedAt: 1, limitsVersion: 2 },
    { id: "other", apiKey: "sk_other", source: "api", addedAt: 2 },
  ],
})
const gate = () => {
  let release!: () => void
  return { promise: new Promise<void>((resolve) => { release = resolve }), release: () => release() }
}
let dir: string
let savedEnv: Record<string, string | undefined>
const isolatedEnv = (key: string) => /^CLINE(_FREE)?_API_KEY/.test(key) || key === "CLINE_FREE_ACCOUNTS_FILE"
beforeEach(async () => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isolatedEnv(key)))
  dir = await mkdtemp(join(tmpdir(), "cline-integration-regressions-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "pool.json")
  for (const key of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(key)) delete process.env[key]
  globalThis.fetch = async () => { throw new Error("unexpected live network") }
  await savePoolFile(seed())
})
afterEach(async () => {
  fs.readFile = realReadFile
  syncBuiltinESMExports()
  globalThis.fetch = realFetch
  await rm(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (isolatedEnv(key)) delete process.env[key]
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value
})
async function rotatedPair(withQuota = false) {
  const peer = await loadPoolFile(), local = await loadPoolFile()
  Object.assign(peer.accounts[0], { access: jwt("peer"), refresh: "r-peer", expires: 4_000_000_000_000 })
  if (withQuota) peer.accounts[0].modelLimits = { capped: Date.now() + 600_000 }
  await savePoolFile(peer)
  return { peer, local }
}

// A refresh adopts more than a token: peer quotas must still govern the next
// selection, without rebasing away unrelated unsaved local metadata.
test("integration: peer adoption retains peer model quota and unrelated pending deltas", { timeout: 5000 }, async () => {
  const { peer, local } = await rotatedPair(true)
  const until = Date.now() + 600_000
  peer.accounts[0].modelLimits!.shared = until
  await savePoolFile(peer)
  local.accounts[0].modelLimits = { localOnly: until + 1000, shared: until + 2000 }
  const expectedLimits = { ...peer.accounts[0].modelLimits, ...local.accounts[0].modelLimits }
  local.accounts[0].label = "local-label"
  local.accounts[1].lastUsed = 123
  await refreshAccount(local, local.accounts[0], log)
  assert.equal(isAvailable(local, local.accounts[0], Date.now(), "capped"), false)
  assert.equal(isAvailable(local, local.accounts[0], Date.now(), "uncapped"), true)
  assert.deepEqual(local.accounts[0].modelLimits, expectedLimits)
  assert.equal(local.accounts[0].label, "local-label")
  assert.equal(local.accounts[1].lastUsed, 123)
  local.accounts[0].authFailedAt = 321
  local.accounts[0].authFailedReason = "current adopted token rejected"
  await savePoolFile(local)
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].authFailedAt, 321)
  assert.equal(disk.accounts[0].label, "local-label")
  assert.equal(disk.accounts[1].lastUsed, 123)
  assert.deepEqual(disk.accounts[0].modelLimits, expectedLimits)
})

test("integration: queued metadata adoption cannot quarantine a healthy peer session", { timeout: 5000 }, async () => {
  const { local } = await rotatedPair(true)
  // Keep this a one-account resolver scenario: no fallback masks a bad refresh.
  const other = local.accounts[1]
  other.authFailedAt = Date.now()
  const entered = gate(), release = gate()
  let intercept = true
  fs.readFile = (async (...args: Parameters<typeof realReadFile>) => {
    if (intercept && args[0] === poolFilePath()) {
      intercept = false
      entered.release()
      await release.promise
    }
    return realReadFile(...args)
  }) as typeof realReadFile
  syncBuiltinESMExports()
  const sent: string[] = []
  globalThis.fetch = async (_url, init) => {
    const refresh = JSON.parse(String(init?.body)).refreshToken as string
    sent.push(refresh)
    if (refresh !== "r-peer") return new Response('{"error":"invalid_grant"}', { status: 400 })
    return new Response(JSON.stringify({ success: true, data: {
      accessToken: jwt("peer-refreshed"), refreshToken: "r-peer-next", expiresAt: "2090-01-01T00:00:00Z",
    } }))
  }
  const saving = savePoolFile(local)
  await entered.promise
  const resolving = resolveActiveToken(local, log, { model: "uncapped" })
  release.release()
  await saving
  assert.equal(await resolving, jwt(sent.length ? "peer-refreshed" : "peer"))
  await savePoolFile(local)
  assert.ok(sent.length <= 1)
  assert.ok(sent.every((refresh) => refresh === "r-peer"), "never replay the stale refresh token")
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].authFailedAt, undefined)
  assert.equal(disk.accounts[0].refresh, sent.length ? "r-peer-next" : "r-peer")
  assert.ok(disk.accounts[0].modelLimits?.capped)
})

test("integration: explicit login intent cannot authorize a later stale credential mutation", { timeout: 5000 }, async () => {
  const { local } = await rotatedPair()
  forgetRemoval(local, jwt("login"))
  upsertOAuthAccount(local, { access: jwt("login"), refresh: "r-login", expires: 4_100_000_000_000 })
  await savePoolFile(local)
  assert.equal((await loadPoolFile()).accounts[0].refresh, "r-login")
  const peer = await loadPoolFile()
  Object.assign(peer.accounts[0], { access: jwt("next-peer"), refresh: "r-next-peer", expires: 4_200_000_000_000 })
  await savePoolFile(peer)
  Object.assign(local.accounts[0], { access: jwt("stale-edit"), refresh: "r-stale-edit", expires: 4_300_000_000_000 })
  local.accounts[0].label = "metadata-survives"
  await savePoolFile(local)
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].refresh, "r-next-peer")
  assert.equal(disk.accounts[0].label, "metadata-survives")
})

test("integration: explicit login during pending stale save survives its next persistence", { timeout: 5000 }, async () => {
  const { local } = await rotatedPair()
  const entered = gate(), release = gate()
  let intercept = true
  fs.readFile = (async (...args: Parameters<typeof realReadFile>) => {
    if (intercept && args[0] === poolFilePath()) {
      intercept = false
      entered.release()
      await release.promise
    }
    return realReadFile(...args)
  }) as typeof realReadFile
  syncBuiltinESMExports()
  const saving = savePoolFile(local)
  await entered.promise
  forgetRemoval(local, jwt("login"))
  upsertOAuthAccount(local, { access: jwt("login"), refresh: "r-login", expires: 4_100_000_000_000 })
  release.release()
  await saving
  assert.equal(local.accounts[0].refresh, "r-login")
  await savePoolFile(local)
  assert.equal((await loadPoolFile()).accounts[0].refresh, "r-login")
})

test("integration: model cooldown reported during an in-flight refresh is preserved", { timeout: 5000 }, async () => {
  const local = await loadPoolFile()
  const entered = gate(), release = gate()
  globalThis.fetch = async () => {
    entered.release()
    await release.promise
    return new Response(JSON.stringify({ success: true, data: {
      accessToken: jwt("fresh"), refreshToken: "r-fresh", expiresAt: "2090-01-01T00:00:00Z",
    } }))
  }
  const refreshing = refreshAccount(local, local.accounts[0], log)
  await entered.promise
  local.accounts[0].modelLimits = { capped: Date.now() + 600_000 }
  release.release()
  await refreshing
  assert.equal(isAvailable(local, local.accounts[0], Date.now(), "capped"), false)
  assert.equal(isAvailable(local, local.accounts[0], Date.now(), "uncapped"), true)
  assert.ok((await loadPoolFile()).accounts[0].modelLimits?.capped)
})
