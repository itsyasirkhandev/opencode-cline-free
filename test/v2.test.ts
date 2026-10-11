import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mergeConnectionCredential, refreshViaPool } from "../src/core/account.ts"
import { recoverResponse } from "../src/core/router.ts"
import type { Logger, PoolFile } from "../src/core/pool.ts"
import { providerInput, setup, toModelInfo } from "../src/v2.ts"

const log: Logger = () => {}
const CHAT = "https://api.cline.bot/api/v1/chat/completions"
const realFetch = globalThis.fetch

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-v2-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "accounts.json")
  process.env.CLINE_FREE_MODELS_FILE = join(dir, "models.json")
  for (const k of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(k)) delete process.env[k]
  // Offline by default: no test may reach the live Cline API.
  globalThis.fetch = (async () => {
    throw new Error("offline")
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`

const apiPool = (n: number): PoolFile => ({
  version: 1,
  accounts: Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    label: `acct${i}`,
    apiKey: `sk_test_${i}`,
    source: "api" as const,
    addedAt: i,
  })),
})

const chatRequest = (token: string, model = "cline-free/mimo-v2.6-flash") =>
  new Request(CHAT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  })

// --- model mapping ---

test("toModelInfo maps limits, inputs, cost and reasoning variants", () => {
  const muse = toModelInfo({ id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3" })
  assert.equal(muse.id, "cline-free/muse-spark-1.3-contributor")
  assert.equal(muse.modelID, muse.id)
  assert.equal(muse.providerID, "cline-free")
  assert.equal(muse.name, "Muse Spark 1.3 (free)")
  assert.deepEqual(muse.variants.map((v) => v.id), ["minimal", "low", "medium", "high", "xhigh"])
  assert.deepEqual(muse.variants[0].settings, { reasoningEffort: "minimal" })
  assert.equal(muse.capabilities.tools, true)

  const unknown = toModelInfo({ id: "x/unknown" })
  assert.deepEqual(unknown.limit, { context: 200_000, output: 32_000 })
  assert.deepEqual(unknown.capabilities.input, ["text"])
  assert.deepEqual(unknown.cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
})

test("providerInput targets the Cline gateway with the surface headers", () => {
  const { info, models } = providerInput([{ id: "cline-free/mimo-v2.6-flash" }], {})
  assert.equal(info.id, "cline-free")
  assert.equal(info.activation, "enabled")
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(info.settings?.baseURL, "https://api.cline.bot/api/v1")
  assert.equal(info.headers?.["X-Title"], "Cline")
  assert.equal(models.length, 1)
})

// --- credential merge / refresh ---

test("mergeConnectionCredential adds keys and never regresses a rotated OAuth session", () => {
  const pool: PoolFile = { version: 1, accounts: [] }
  mergeConnectionCredential(pool, { type: "key", key: "sk_test_k" })
  assert.equal(pool.accounts.length, 1)

  const fresh = jwt({ sub: "user_1", sid: "new" })
  const stale = jwt({ sub: "user_1", sid: "old" })
  mergeConnectionCredential(pool, { type: "oauth", access: fresh, refresh: "r_new", expires: 2_000 })
  assert.equal(pool.accounts.length, 2)
  mergeConnectionCredential(pool, { type: "oauth", access: stale, refresh: "r_old", expires: 1_000 })
  const acc = pool.accounts.find((a) => a.access)!
  assert.equal(acc.refresh, "r_new")
  assert.equal(acc.access, fresh)
})

test("refreshViaPool returns the pool's rotated session without spending the refresh token", async () => {
  const current = jwt({ sub: "user_2", sid: "current" })
  const pool: PoolFile = {
    version: 1,
    accounts: [{ id: "o1", access: current, refresh: "r_current", expires: Date.now() + 3_600_000, source: "oauth", addedAt: 0 }],
  }
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response("{}", { status: 500 })
  }) as typeof fetch
  const out = await refreshViaPool(pool, { access: jwt({ sub: "user_2", sid: "stale" }), refresh: "r_stale", expires: 0 }, log)
  assert.equal(out.access, current)
  assert.equal(out.refresh, "r_current")
  assert.equal(calls, 0)
})

// --- failover on an already-received response ---

test("recoverResponse replays a 429 on the next account", async () => {
  const pool = apiPool(2)
  const seen: string[] = []
  const res = await recoverResponse(pool, log, chatRequest("sk_test_0"), new Response("rate limited", { status: 429 }), (async (_u: any, init: any) => {
    seen.push(new Headers(init.headers).get("authorization")!)
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "ok")
  assert.deepEqual(seen, ["Bearer sk_test_1"])
  assert.ok(pool.accounts[0].modelLimits?.["cline-free/mimo-v2.6-flash"])
})

test("recoverResponse leaves successful and paid-model responses alone", async () => {
  let calls = 0
  const count = (async () => {
    calls++
    return new Response("ok", { status: 200 })
  }) as typeof fetch
  const ok = new Response("fine", { status: 200 })
  assert.equal(await recoverResponse(apiPool(2), log, chatRequest("sk_test_0"), ok, count), ok)
  const paid = await recoverResponse(apiPool(3), log, chatRequest("sk_test_0", "z-ai/glm-5.3-flash"), new Response("rate limited", { status: 429 }), count)
  assert.equal(paid.status, 429)
  assert.equal(calls, 0)
})

// --- setup against a fake V2 context ---

function fakeContext() {
  const providers: unknown[] = []
  const methods: { method: { type: string; id?: string } }[] = []
  const tools: { name: string; execute: (input: unknown, ctx: unknown) => Promise<{ content?: unknown }> }[] = []
  const hooks = new Map<string, { callback: (event: any) => Promise<void> | void; providerID?: string }>()
  const registration = { dispose: async () => {} }
  const ctx = {
    provider: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (input: unknown) => providers.push(input) })
        return registration
      },
      reload: async () => {},
    },
    integration: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ update: (_id: string, fn: (i: { name: string }) => void) => fn({ name: "" }), method: { update: (m: any) => methods.push(m) } })
        return registration
      },
      connection: { active: async () => undefined, resolve: async () => undefined },
    },
    session: {
      hook: async (name: string, callback: any, options?: { providerID?: string }) => {
        hooks.set(name, { callback, providerID: options?.providerID })
        return registration
      },
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (t: any) => tools.push(t) })
        return registration
      },
    },
  }
  return { ctx, providers, methods, tools, hooks }
}

test("setup registers the provider, login methods, scoped HTTP hooks and tools", async () => {
  writeFileSync(process.env.CLINE_FREE_ACCOUNTS_FILE!, JSON.stringify(apiPool(2)))
  const { ctx, providers, methods, tools, hooks } = fakeContext()
  const cleanup = await setup(ctx as unknown as Parameters<typeof setup>[0])

  assert.equal(providers.length, 1)
  assert.deepEqual(methods.map((m) => m.method.id ?? m.method.type), ["device", "cli", "key"])
  assert.deepEqual(tools.map((t) => t.name), ["cline_free_status", "cline_free_remove", "cline_free_add_token"])
  assert.equal(hooks.get("http.request")?.providerID, "cline-free")
  assert.equal(hooks.get("http.response")?.providerID, "cline-free")

  // http.request stamps the pool-chosen account.
  const event = { request: new Request(CHAT, { method: "POST", body: "{}" }) }
  await hooks.get("http.request")!.callback(event)
  assert.match(event.request.headers.get("authorization") ?? "", /^Bearer sk_test_[01]$/)

  // The status tool reads the same pool.
  const status = await tools[0].execute({}, {})
  assert.match(String(status.content), /2 stored/)

  assert.equal(typeof cleanup, "function")
})
