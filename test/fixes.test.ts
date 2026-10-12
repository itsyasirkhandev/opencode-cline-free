import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mergeConnectionCredential, refreshViaPool, resolveActiveToken, tidyPool } from "../src/core/account.ts"
import { pollDeviceAuth } from "../src/core/auth.ts"
import { createRoutedFetch, recoverResponse } from "../src/core/router.ts"
import {
  type Logger,
  type PoolFile,
  allCandidates,
  forgetRemoval,
  pinnedAccountId,
  quarantineAccount,
  upsertApiAccount,
  upsertOAuthAccount,
} from "../src/core/pool.ts"
import { removeAccount } from "../src/core/tools.ts"
import { credentialEmail } from "../src/v2.ts"

const log: Logger = () => {}
const CHAT = "https://api.cline.bot/api/v1/chat/completions"
const realFetch = globalThis.fetch

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-fixes-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "accounts.json")
  process.env.CLINE_FREE_MODELS_FILE = join(dir, "models.json")
  for (const k of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(k)) delete process.env[k]
  globalThis.fetch = (async () => {
    throw new Error("offline")
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const k of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(k)) delete process.env[k]
})

const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`
const emptyPool = (): PoolFile => ({ version: 1, accounts: [] })
const apiPool = (n: number): PoolFile => ({
  version: 1,
  accounts: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `acct${i}`, apiKey: `sk_test_${i}`, source: "api" as const, addedAt: i })),
})
const chat = (token: string, model = "cline-free/solar-mini4", init: RequestInit = {}) =>
  new Request(CHAT, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model }), ...init })
const tokenOfCall = (init: RequestInit | undefined) => new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, "")

/** Fake Cline: answers per token, records every token it saw. */
const fakeCline = (status: (token: string) => number) => {
  const seen: string[] = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const t = tokenOfCall(init)
    seen.push(t)
    return new Response(`{"error":"status ${status(t)}"}`, { status: status(t) })
  }) as typeof fetch
  return { seen, fetchFn }
}

// --- 1. env accounts fail over and cool down ---

test("env accounts: a 429 fails over to the next env key and parks the first", async () => {
  process.env.CLINE_API_KEYS = "envkey_AAAAAAAA_1,envkey_BBBBBBBB_2"
  const pool = emptyPool()
  const { seen, fetchFn } = fakeCline((t) => (t.includes("AAAA") ? 429 : 200))
  const res = await createRoutedFetch(pool, log, fetchFn)(chat("envkey_AAAAAAAA_1"))
  assert.equal(res.status, 200)
  assert.deepEqual(seen, ["envkey_AAAAAAAA_1", "envkey_BBBBBBBB_2"])
  // The cooldown sticks: the next pick for this model skips key 1.
  for (let i = 0; i < 3; i++) assert.equal(await resolveActiveToken(pool, log, { model: "cline-free/solar-mini4" }), "envkey_BBBBBBBB_2")
})

test("env accounts: a 402 on a paid model switches to the next env key", async () => {
  process.env.CLINE_API_KEYS = "envkey_AAAAAAAA_1,envkey_BBBBBBBB_2"
  const { seen, fetchFn } = fakeCline((t) => (t.includes("AAAA") ? 402 : 200))
  const res = await createRoutedFetch(emptyPool(), log, fetchFn)(chat("envkey_AAAAAAAA_1", "openai/gpt-6.1-sol"))
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
})

test("env accounts: a dead env key is quarantined and the request moves on", async () => {
  process.env.CLINE_API_KEYS = "envkey_AAAAAAAA_1,envkey_BBBBBBBB_2"
  const pool = emptyPool()
  const { fetchFn } = fakeCline((t) => (t.includes("AAAA") ? 401 : 200))
  const res = await createRoutedFetch(pool, log, fetchFn)(chat("envkey_AAAAAAAA_1"))
  assert.equal(res.status, 200)
  assert.deepEqual(allCandidates(pool).map((a) => a.apiKey), ["envkey_BBBBBBBB_2"])
})

// --- 2. the per-request connection merge never resets health ---

test("manual token connection: merging before each request keeps NEEDS-RELOGIN and cooldowns", () => {
  const pool = emptyPool()
  const acc = upsertApiAccount(pool, "sk_manual_token_1234")
  quarantineAccount(pool, acc, "dead", log)
  acc.limitedUntil = Date.now() + 60_000
  for (let i = 0; i < 3; i++) mergeConnectionCredential(pool, { type: "key", key: "sk_manual_token_1234" })
  assert.ok(acc.authFailedAt)
  assert.ok(acc.limitedUntil)
})

test("manual token connection: a pasted workos token never replaces the same user's refreshed session", () => {
  const pool = emptyPool()
  const fresh = jwt({ external_id: "u1", n: "fresh" })
  const pasted = jwt({ external_id: "u1", n: "pasted" })
  upsertOAuthAccount(pool, { access: fresh, refresh: "r", expires: Date.now() + 3_600_000 }, "a@x.com")
  mergeConnectionCredential(pool, { type: "key", key: `workos:${pasted}` })
  assert.equal(pool.accounts.length, 1)
  assert.equal(pool.accounts[0].access, fresh)
})

test("manual token connection: a new token is still added", () => {
  const pool = emptyPool()
  mergeConnectionCredential(pool, { type: "key", key: "sk_new_token_123456" })
  assert.equal(pool.accounts.length, 1)
})

// --- 3. removal sticks ---

test("cline_free_remove: the active connection is not copied back in", async () => {
  const pool = emptyPool()
  const access = jwt({ external_id: "u9" })
  const cred = { type: "oauth" as const, access, refresh: "r", expires: Date.now() + 3_600_000 }
  mergeConnectionCredential(pool, cred)
  assert.equal(pool.accounts.length, 1)
  const msg = await removeAccount(pool, pool.accounts[0].id, log)
  assert.match(msg, /0 stored left/)
  assert.match(msg, /disconnect it there/)
  mergeConnectionCredential(pool, { ...cred, expires: cred.expires + 1000 })
  assert.equal(pool.accounts.length, 0)
  await assert.rejects(refreshViaPool(pool, cred, log), /removed with cline_free_remove/)
  assert.equal(pool.accounts.length, 0)
  // Logging in again brings it back.
  forgetRemoval(pool, access)
  mergeConnectionCredential(pool, { ...cred, expires: cred.expires + 2000 })
  assert.equal(pool.accounts.length, 1)
})

test("cline_free_remove: a removed manual token is not re-added", async () => {
  const pool = emptyPool()
  mergeConnectionCredential(pool, { type: "key", key: "sk_manual_token_9999" })
  await removeAccount(pool, pool.accounts[0].id, log)
  mergeConnectionCredential(pool, { type: "key", key: "sk_manual_token_9999" })
  assert.equal(pool.accounts.length, 0)
})

// --- 4. all-429 replay skips accounts that need re-login ---

test("all accounts 429: the error replay never goes to a NEEDS-RELOGIN account", async () => {
  const pool = apiPool(3)
  quarantineAccount(pool, pool.accounts[2], "dead", log)
  const { seen, fetchFn } = fakeCline((t) => (t === "sk_test_2" ? 401 : 429))
  const res = await createRoutedFetch(pool, log, fetchFn)(chat("sk_test_0"))
  assert.equal(res.status, 429)
  assert.ok(!seen.includes("sk_test_2"))
})

// --- 5. labels keep the saved email ---

test("connection labels fall back to the email saved at login", () => {
  const access = jwt({ sub: "no-email" })
  assert.equal(credentialEmail({ access, metadata: { email: "me@x.com" } }), "me@x.com")
  const pool = emptyPool()
  upsertOAuthAccount(pool, { access, refresh: "r", expires: Date.now() + 3_600_000 }, "pool@x.com")
  assert.equal(credentialEmail({ access }, pool), "pool@x.com")
  assert.equal(credentialEmail({ access: jwt({ email: "Tok@X.com" }) }), "tok@x.com")
})

// --- 6. retries honour cancellation ---

test("a cancelled turn stops failing over to other accounts", async () => {
  const pool = apiPool(3)
  const ctrl = new AbortController()
  const seen: string[] = []
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    seen.push(tokenOfCall(init))
    ctrl.abort()
    return new Response("{}", { status: 429 })
  }) as typeof fetch
  await assert.rejects(createRoutedFetch(pool, log, fetchFn)(chat("sk_test_0", undefined, { signal: ctrl.signal })))
  assert.equal(seen.length, 1)
})

// --- 7. abandoned device logins stop polling ---

test("device login polling stops when the login is abandoned", async () => {
  const ctrl = new AbortController()
  let polls = 0
  globalThis.fetch = (async () => {
    polls++
    setTimeout(() => ctrl.abort(), 5)
    return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })
  }) as typeof fetch
  const started = Date.now()
  await assert.rejects(pollDeviceAuth("code", 600, 5, ctrl.signal), /cancelled|abort/i)
  assert.equal(polls, 1)
  assert.ok(Date.now() - started < 2000)
})

// --- 8. housekeeping runs both steps ---

test("tidyPool removes duplicates even when a cooldown expired in the same pass", () => {
  const pool: PoolFile = {
    version: 1,
    accounts: [
      { id: "old", access: jwt({ external_id: "dup", n: 1 }), source: "oauth", addedAt: 1, limitedUntil: 1 },
      { id: "new", access: jwt({ external_id: "dup", n: 2 }), source: "oauth", addedAt: 2 },
    ],
  }
  tidyPool(pool)
  assert.deepEqual(pool.accounts.map((a) => a.id), ["new"])
})

// --- session pinning (prompt cache) ---

test("session pinning: every turn of a session uses the same account", async () => {
  const pool = apiPool(3)
  const model = "pin/model-a"
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(await resolveActiveToken(pool, log, { model, sessionID: "ses_1" }))
  assert.equal(new Set(picks).size, 1)
  // Other sessions still spread across the pool.
  const others = []
  for (let i = 0; i < 3; i++) others.push(await resolveActiveToken(pool, log, { model, sessionID: `ses_other_${i}` }))
  assert.ok(new Set([picks[0], ...others]).size > 1)
})

test("session pinning: the session moves only when its account is rate limited, then stays on the new one", async () => {
  const pool = apiPool(3)
  const model = "pin/model-b"
  const first = (await resolveActiveToken(pool, log, { model, sessionID: "ses_2" }))!
  const { fetchFn } = fakeCline((t) => (t === first ? 429 : 200))
  const original = chat(first, model)
  const res = await recoverResponse(pool, log, original, new Response("{}", { status: 429 }), fetchFn, { sessionID: "ses_2" })
  assert.equal(res.status, 200)
  const moved = (await resolveActiveToken(pool, log, { model, sessionID: "ses_2" }))!
  assert.notEqual(moved, first)
  assert.equal(pinnedAccountId(pool, "ses_2", model), pool.accounts.find((a) => a.apiKey === moved)!.id)
  // Even after the first account recovers, the session keeps its warm account.
  for (const a of pool.accounts) {
    delete a.limitedUntil
    delete a.modelLimits
  }
  for (let i = 0; i < 3; i++) assert.equal(await resolveActiveToken(pool, log, { model, sessionID: "ses_2" }), moved)
})

test("session pinning: pins are per model", async () => {
  const pool = apiPool(2)
  pool.accounts[0].modelLimits = { "pin/model-c": Date.now() + 60_000 }
  assert.equal(await resolveActiveToken(pool, log, { model: "pin/model-c", sessionID: "ses_3" }), "sk_test_1")
  const other = await resolveActiveToken(pool, log, { model: "pin/model-d", sessionID: "ses_3" })
  assert.ok(other)
})
