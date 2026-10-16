import { afterEach, beforeEach, mock, test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PoolFile,
  isAvailable,
  loadPoolFile,
  refreshAccount,
  savePoolFile,
  upsertOAuthAccount,
} from "../src/core/pool.ts"
import { setup } from "../src/v2.ts"

const CHAT = "https://api.cline.bot/api/v1/chat/completions"
const NOW = Date.UTC(2030, 0, 1)
const CAPPED_MODEL = "cline-free/boundary-capped"
const OTHER_MODEL = "cline-free/boundary-other"
const accessToken = (session: string) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "boundary-user", sid: session })).toString("base64url")}.fake`
const OLD_ACCESS = accessToken("old")
const FRESH_ACCESS = accessToken("fresh")
const PEER_ACCESS = accessToken("peer")
const log = () => {}
const realFetch = globalThis.fetch
const isolatedEnv = (key: string) => /^CLINE(_FREE)?_API_KEY/.test(key) ||
  key === "CLINE_FREE_ACCOUNTS_FILE" || key === "CLINE_FREE_MODELS_FILE"
let savedEnv: Record<string, string | undefined>
let dir: string
let fetchCalls: number

beforeEach(async () => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isolatedEnv(key)))
  for (const key of Object.keys(process.env)) if (isolatedEnv(key)) delete process.env[key]
  dir = await mkdtemp(join(tmpdir(), "cline-boundary-regressions-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "pool.json")
  process.env.CLINE_FREE_MODELS_FILE = join(dir, "models.json")
  mock.method(Date, "now", () => NOW)
  fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls++
    throw new Error("live network disabled in boundary regressions")
  }
})

afterEach(async () => {
  mock.restoreAll()
  globalThis.fetch = realFetch
  for (const key of Object.keys(process.env)) if (isolatedEnv(key)) delete process.env[key]
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value
  await rm(dir, { recursive: true, force: true })
})

const apiPool = (): PoolFile => ({
  version: 1,
  accounts: [{ id: "pooled", apiKey: "sk_boundary_pool_fake", source: "api", addedAt: 1, limitsVersion: 2 }],
})

const oauthPool = (): PoolFile => ({
  version: 1,
  accounts: [{
    id: "oauth",
    access: OLD_ACCESS,
    refresh: "boundary-old-refresh",
    expires: NOW - 1,
    source: "oauth",
    addedAt: 1,
    limitsVersion: 2,
    modelLimits: { [CAPPED_MODEL]: NOW + 3_600_000 },
  }],
})

const tokenResponse = () => new Response(JSON.stringify({
  success: true,
  data: {
    accessToken: FRESH_ACCESS,
    refreshToken: "boundary-fresh-refresh",
    expiresAt: new Date(NOW + 7_200_000).toISOString(),
  },
}))

type HookEvent = { sessionID: string; request: Request }

// Exercise setup's actual http.request registration, not a copied adapter
// callback or the independently guarded core fetch wrapper.
async function v2Harness(t: TestContext, initial: PoolFile = apiPool()) {
  await writeFile(process.env.CLINE_FREE_ACCOUNTS_FILE!, JSON.stringify(initial))
  const hooks = new Map<string, { callback: (event: HookEvent) => Promise<void>; providerID?: string }>()
  const tools = new Map<string, { execute: () => Promise<{ content: unknown }> }>()
  const connectionCalls = { active: 0, resolve: 0 }
  const registration = { dispose: async () => {} }
  const ctx = {
    provider: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: () => {} })
        return registration
      },
      reload: async () => {},
    },
    integration: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ update: (_id: string, fn: (i: { name: string }) => void) => fn({ name: "" }), method: { update: () => {} } })
        return registration
      },
      connection: {
        active: async () => { connectionCalls.active++; return undefined },
        resolve: async () => { connectionCalls.resolve++; return undefined },
      },
    },
    session: {
      hook: async (name: string, callback: (event: HookEvent) => Promise<void>, options?: { providerID?: string }) => {
        hooks.set(name, { callback, providerID: options?.providerID })
        return registration
      },
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (tool: { name: string; execute: () => Promise<{ content: unknown }> }) => tools.set(tool.name, tool) })
        return registration
      },
    },
  }
  const cleanup = await setup(ctx as unknown as Parameters<typeof setup>[0])
  t.after(async () => { if (typeof cleanup === "function") await cleanup() })
  const hook = hooks.get("http.request")!
  assert.equal(hook.providerID, "cline-free")
  return {
    request: hook.callback,
    status: async () => (await tools.get("cline_free_status")!.execute()).content,
    connectionCalls,
  }
}

for (const url of [
  CHAT,
  `${CHAT}/`,
  `${CHAT}?stream=true`,
  "https://api.cline.bot/api/v1/completions",
  "https://API.CLINE.BOT:443/api/v1/completions/",
]) {
  test(`V2 credential boundary: trusted completion ${url}`, async (t) => {
    const harness = await v2Harness(t)
    const body = JSON.stringify({ model: OTHER_MODEL, messages: [] })
    const request = new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer caller-fake", "x-keep": "original" },
      body,
    })
    const event = { sessionID: "boundary-trusted", request }
    await harness.request(event)
    assert.equal(event.request, request)
    assert.equal(request.headers.get("authorization"), "Bearer sk_boundary_pool_fake")
    assert.equal(request.headers.get("x-task-id"), event.sessionID)
    assert.equal(request.headers.get("x-keep"), "original")
    assert.equal(request.bodyUsed, false)
    assert.equal(await request.text(), body)
    assert.deepEqual(harness.connectionCalls, { active: 1, resolve: 0 })
  })
}

for (const url of [
  "https://api.cline.bot.attacker.invalid/api/v1/chat/completions",
  "https://attacker.invalid/api/v1/chat/completions",
  "http://api.cline.bot/api/v1/chat/completions",
  "https://api.cline.bot:444/api/v1/chat/completions",
  "https://api.cline.bot/api/v1/users/me?next=/chat/completions",
  `${CHAT}/extra`,
  `${CHAT}-extra`,
  "https://api.cline.bot/api/v1/chat%2fcompletions",
]) {
  for (const callerAuth of [undefined, "Bearer caller-fake"]) {
    test(`V2 credential boundary: untouched ${callerAuth ? "caller-auth" : "no-auth"} ${url}`, async (t) => {
      const harness = await v2Harness(t)
      const beforeStatus = await harness.status()
      const beforeDisk = await readFile(process.env.CLINE_FREE_ACCOUNTS_FILE!, "utf8")
      const beforeFiles = await readdir(dir)
      const beforeFetches = fetchCalls
      const body = JSON.stringify({ model: OTHER_MODEL, messages: [] })
      const headers = new Headers({ "x-task-id": "caller-task", "x-keep": "original" })
      if (callerAuth) headers.set("authorization", callerAuth)
      const request = new Request(url, { method: "POST", headers, body })
      const beforeHeaders = Array.from(request.headers)
      const clone = t.mock.method(request, "clone")
      const event = { sessionID: "boundary-untrusted", request }
      await harness.request(event)
      assert.equal(event.request, request)
      assert.deepEqual(Array.from(request.headers), beforeHeaders, "do not add pooled credentials or alter caller headers")
      assert.equal(request.url, url)
      assert.equal(request.method, "POST")
      assert.equal(request.bodyUsed, false)
      assert.equal(await request.text(), body)
      assert.equal(clone.mock.callCount(), 0, "do not even clone out-of-scope bodies")
      assert.deepEqual(harness.connectionCalls, { active: 0, resolve: 0 }, "reject before resolving or merging credentials")
      assert.equal(fetchCalls, beforeFetches, "do not refresh, probe or make other network calls")
      assert.equal(await harness.status(), beforeStatus, "do not select or activate a pool account")
      assert.equal(await readFile(process.env.CLINE_FREE_ACCOUNTS_FILE!, "utf8"), beforeDisk)
      assert.deepEqual(await readdir(dir), beforeFiles, "do not write pool or lock files")
    })
  }
}

test("refresh model limits: V2 refresh for another model preserves quota and routes capped model away", async (t) => {
  const initial = oauthPool()
  initial.accounts.push(apiPool().accounts[0])
  const harness = await v2Harness(t, initial)
  let refreshes = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.cline.bot/api/v1/auth/refresh")
    assert.equal(JSON.parse(String(init?.body)).refreshToken, "boundary-old-refresh")
    refreshes++
    return tokenResponse()
  }
  const requestFor = (model: string) => ({
    sessionID: "boundary-refresh",
    request: new Request(CHAT, { method: "POST", body: JSON.stringify({ model, messages: [] }) }),
  })
  const other = requestFor(OTHER_MODEL)
  await harness.request(other)
  assert.equal(other.request.headers.get("authorization"), `Bearer workos:${FRESH_ACCESS}`)
  assert.equal(refreshes, 1)
  const disk = await loadPoolFile()
  assert.deepEqual(disk.accounts[0].modelLimits, initial.accounts[0].modelLimits)
  assert.equal(isAvailable(disk, disk.accounts[0], NOW, CAPPED_MODEL), false)
  assert.equal(isAvailable(disk, disk.accounts[0], NOW, OTHER_MODEL), true)
  const capped = requestFor(CAPPED_MODEL)
  await harness.request(capped)
  assert.equal(capped.request.headers.get("authorization"), "Bearer sk_boundary_pool_fake")
  assert.equal(refreshes, 1)
})

test("refresh model limits: successful authentication clears quarantine but keeps model quota", async () => {
  const initial = oauthPool()
  Object.assign(initial.accounts[0], { authFailedAt: NOW - 10, authFailedReason: "expired session", lastProbeAt: NOW - 5 })
  await savePoolFile(initial)
  const pool = await loadPoolFile()
  globalThis.fetch = async () => tokenResponse()
  await refreshAccount(pool, pool.accounts[0], log)
  assert.equal(pool.accounts[0].access, FRESH_ACCESS)
  assert.equal(pool.accounts[0].authFailedAt, undefined)
  assert.equal(pool.accounts[0].authFailedReason, undefined)
  assert.equal(pool.accounts[0].lastProbeAt, undefined)
  assert.deepEqual(pool.accounts[0].modelLimits, initial.accounts[0].modelLimits)
  assert.deepEqual((await loadPoolFile()).accounts[0].modelLimits, initial.accounts[0].modelLimits)
})

test("refresh model limits: adopting a peer-refreshed token does not erase model quota", async () => {
  await savePoolFile(oauthPool())
  const local = await loadPoolFile()
  const expectedLimits = structuredClone(local.accounts[0].modelLimits)
  const peer = await loadPoolFile()
  Object.assign(peer.accounts[0], { access: PEER_ACCESS, refresh: "boundary-peer-refresh", expires: NOW + 7_200_000 })
  await savePoolFile(peer)
  await refreshAccount(local, local.accounts[0], log)
  assert.equal(local.accounts[0].access, PEER_ACCESS)
  assert.equal(fetchCalls, 0, "adopt peer credentials without spending the refresh token")
  assert.deepEqual(local.accounts[0].modelLimits, expectedLimits)
  assert.equal(isAvailable(local, local.accounts[0], NOW, CAPPED_MODEL), false)
})

test("refresh model limits: explicit re-login retains its existing full health reset", () => {
  const pool = oauthPool()
  const account = upsertOAuthAccount(pool, { access: OLD_ACCESS, refresh: "relogin-fake", expires: NOW + 7_200_000 })
  assert.equal(pool.accounts.length, 1)
  assert.equal(account.refresh, "relogin-fake")
  assert.equal(account.modelLimits, undefined)
})
