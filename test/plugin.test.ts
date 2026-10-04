import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FALLBACK_FREE, EXTRA_MODELS, MODELS, displayName, isPaidModel, modelConfig } from "../src/models.ts"
import { classifyHttpFailure, TerminalAuthError, TransientAuthError } from "../src/http.ts"
import { selectAccount, withFileLock, type PoolFile, type Logger } from "../src/pool.ts"
import { createRoutedFetch } from "../src/router.ts"
import { loadFreeModels, readModelsCache, writeModelsCache } from "../src/modelList.ts"

const log: Logger = () => {}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-test-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "accounts.json")
  process.env.CLINE_FREE_MODELS_FILE = join(dir, "models.json")
  for (const k of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(k)) delete process.env[k]
})

function poolOf(n: number): PoolFile {
  return {
    version: 1,
    accounts: Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      label: `acct${i}`,
      apiKey: `sk_test_${i}`,
      source: "api" as const,
      addedAt: i,
    })),
  }
}

// --- models ---

test("fallback list matches the current free rotation", () => {
  assert.deepEqual(
    FALLBACK_FREE.map((m) => m.id).sort(),
    [
      "cline-free/deepseek-v4.1-flash",
      "cline-free/mimo-v2.6-flash",
      "cline-free/muse-spark-1.3-contributor",
      "stealth/space-bunny-alpha",
    ],
  )
})

test("every free model has explicit limits and input modalities", () => {
  for (const m of FALLBACK_FREE) {
    assert.ok(MODELS[m.id].limit, `${m.id} limit`)
    assert.ok(MODELS[m.id].input, `${m.id} input`)
  }
})

test("paid GLM is labelled (paid), never (free)", () => {
  assert.ok(isPaidModel("z-ai/glm-5.3-flash"))
  assert.equal(EXTRA_MODELS[0].paid, true)
  assert.equal(displayName(EXTRA_MODELS[0]), "GLM 5.3 Flash (paid)")
  assert.equal(displayName({ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" }), "GLM 5.3 Flash (paid)")
  assert.equal(displayName({ id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" }), "Mimo V2.6 Flash (free)")
})

test("modelConfig maps variants and defaults", () => {
  const muse = modelConfig({ id: "cline-free/muse-spark-1.3-contributor" })
  assert.deepEqual(Object.keys(muse.variants ?? {}), ["minimal", "low", "medium", "high", "xhigh"])
  const laguna = modelConfig({ id: "poolside/laguna-s-2.1:free" })
  assert.equal("variants" in laguna, false)
  const unknown = modelConfig({ id: "x/unknown" })
  assert.deepEqual(unknown.limit, { context: 200_000, output: 32_000 })
  assert.deepEqual(unknown.modalities.input, ["text"])
})

// --- http classification ---

test("classifyHttpFailure separates terminal from transient", () => {
  assert.ok(classifyHttpFailure(400, "invalid_grant", "refresh") instanceof TerminalAuthError)
  assert.ok(classifyHttpFailure(429, undefined, "refresh") instanceof TransientAuthError)
  assert.ok(classifyHttpFailure(503, undefined, "refresh") instanceof TransientAuthError)
  assert.ok(classifyHttpFailure(404, undefined, "refresh") instanceof TerminalAuthError)
})

// --- rotation ---

test("rotation spreads evenly over healthy accounts per model", () => {
  const pool = poolOf(3)
  pool.accounts[0].modelLimits = { m: Date.now() + 60_000 }
  const picks = Array.from({ length: 6 }, () => selectAccount(pool, Date.now(), "m")!.id)
  const counts = picks.reduce<Record<string, number>>((c, id) => ((c[id] = (c[id] ?? 0) + 1), c), {})
  assert.equal(counts.a0, undefined)
  assert.equal(counts.a1, 3)
  assert.equal(counts.a2, 3)
})

// --- lock heartbeat ---

test("a long-held lock is not broken as stale", async () => {
  const order: string[] = []
  const holder = withFileLock(
    async () => {
      order.push("A start")
      await new Promise((r) => setTimeout(r, 900))
      order.push("A end")
    },
    { staleMs: 300, timeoutMs: 5000 },
  )
  await new Promise((r) => setTimeout(r, 50))
  const waiter = withFileLock(
    async () => {
      order.push("B")
    },
    { staleMs: 300, timeoutMs: 5000 },
  )
  await Promise.all([holder, waiter])
  assert.deepEqual(order, ["A start", "A end", "B"])
})

// --- router ---

const CHAT = "https://api.cline.bot/api/v1/chat/completions"
const body = (model: string) => JSON.stringify({ model, messages: [] })

test("free model 429 fails over to the next account", async () => {
  const pool = poolOf(2)
  const seen: string[] = []
  const routed = createRoutedFetch(pool, log, (async (_u: any, init: any) => {
    const auth = new Headers(init.headers).get("authorization")!
    seen.push(auth)
    return auth.endsWith("sk_test_0")
      ? new Response("rate limited", { status: 429 })
      : new Response("ok", { status: 200 })
  }) as typeof fetch)
  const res = await routed(CHAT, {
    method: "POST",
    headers: { authorization: "Bearer sk_test_0" },
    body: body("cline-free/mimo-v2.6-flash"),
  })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "ok")
  assert.deepEqual(seen, ["Bearer sk_test_0", "Bearer sk_test_1"])
})

test("paid model is sent exactly once and never replayed on another account", async () => {
  const pool = poolOf(3)
  let calls = 0
  const routed = createRoutedFetch(pool, log, (async () => {
    calls++
    return new Response("rate limited", { status: 429 })
  }) as typeof fetch)
  const res = await routed(CHAT, {
    method: "POST",
    headers: { authorization: "Bearer sk_test_0" },
    body: body("z-ai/glm-5.3-flash"),
  })
  assert.equal(res.status, 429)
  assert.equal(calls, 1)
})

test("non-Cline URLs pass straight through", async () => {
  let calls = 0
  const routed = createRoutedFetch(poolOf(1), log, (async () => {
    calls++
    return new Response("x")
  }) as typeof fetch)
  await routed("https://example.com/other", { method: "GET" })
  assert.equal(calls, 1)
})

// --- model cache ---

test("model list: cache round-trip, background refresh, offline fallback", async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as typeof fetch
    const offline = await loadFreeModels(undefined, 200)
    assert.equal(offline.source, "fallback")
    assert.ok(offline.entries.some((e) => e.id === "z-ai/glm-5.3-flash"))

    await writeModelsCache([{ id: "cline-free/mimo-v2.6-flash" }])
    assert.deepEqual((await readModelsCache())?.map((e) => e.id), ["cline-free/mimo-v2.6-flash"])

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ free: [{ id: "stealth/new-model" }] }), { status: 200 })) as typeof fetch
    const cached = await loadFreeModels(undefined, 200)
    assert.equal(cached.source, "cache")
    assert.equal(cached.entries[0].id, "cline-free/mimo-v2.6-flash")
    const fresh = await cached.refreshed
    assert.equal(fresh?.[0].id, "stealth/new-model")
    assert.equal((await readModelsCache())?.[0].id, "stealth/new-model")
  } finally {
    globalThis.fetch = realFetch
  }
})
