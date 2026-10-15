import { test, beforeEach, afterEach, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { once, getEventListeners } from "node:events"
import { mkdtemp, readFile, writeFile, stat, readdir, mkdir, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  type PoolFile,
  loadPoolFile,
  savePoolFile,
  poolFilePath,
  allCandidates,
  isAvailable,
  isRoutableUrl,
  markAccountLimited,
  pruneLimits,
  cooldownUntil,
  rememberRemoval,
  forgetRemoval,
  upsertApiAccount,
  refreshAccount,
  withFileLock,
} from "../src/core/pool.ts"
import { AUTH_TIMEOUT_MS, fetchWithTimeout, TerminalAuthError, TransientAuthError } from "../src/core/http.ts"
import { startDeviceAuth, registerWorkOSTokens, refreshClineToken, pollDeviceAuth } from "../src/core/auth.ts"
import { createRoutedFetch } from "../src/core/router.ts"
import { poolStatusText } from "../src/core/tools.ts"

const CHAT = "https://api.cline.bot/api/v1/chat/completions"
const log = () => {}
const realFetch = globalThis.fetch
let dir: string
const children = new Set<ChildProcess>()
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const apiPool = (): PoolFile => ({
  version: 1,
  accounts: [
    { id: "a", apiKey: "sk_test_primary", source: "api", addedAt: 1 },
    { id: "b", apiKey: "sk_test_secondary", source: "api", addedAt: 2 },
  ],
})
const oauthPool = (): PoolFile => ({
  version: 1,
  accounts: [{ id: "oauth", access: "old-access", refresh: "old-refresh", expires: 1, source: "oauth", addedAt: 1 }],
})
const tokenResponse = () =>
  new Response(
    JSON.stringify({
      success: true,
      data: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: "2090-01-01T00:00:00Z",
      },
    }),
  )
const deviceResponse = () =>
  new Response(JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "https://example.test/device" }))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cline-review-regressions-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "nested", "pool.json")
  for (const key of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(key)) delete process.env[key]
  globalThis.fetch = async () => {
    throw new Error("live network disabled in regression tests")
  }
})
afterEach(async () => {
  globalThis.fetch = realFetch
  for (const child of children) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  children.clear()
  for (const key of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(key)) delete process.env[key]
})

async function worker() {
  const child = fork(new URL("./fixtures/pool-worker.ts", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  children.add(child)
  await once(child, "message")
  return async (action: string, value?: string) => {
    const response = once(child, "message")
    child.send({ action, value })
    const [message] = await response
    if (message.error) throw new Error(message.error)
    return message
  }
}

// 1. Every writer participates in the refresh mutex, with delta/CAS merging.
test("persistence: separate processes cannot undo rotation with a stale metadata snapshot", async () => {
  await savePoolFile(oauthPool())
  const fresh = await worker(),
    stale = await worker()
  await Promise.all([fresh("load"), stale("load")])
  await fresh("rotate")
  await stale("metadata")
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].access, "rotated-access")
  assert.equal(disk.accounts[0].refresh, "rotated-refresh")
  assert.equal(disk.accounts[0].expires, 4_000_000_000_000)
  assert.equal(disk.accounts[0].lastUsed, 123456)
  assert.equal(disk.accounts[0].modelLimits, undefined, "stale-credential health cannot poison rotated credentials")
  assert.equal((await stat(poolFilePath())).mode & 0o777, 0o600)
})

test("persistence: simultaneous cross-process additions survive", async () => {
  await savePoolFile(oauthPool())
  const a = await worker(),
    b = await worker()
  await Promise.all([a("load"), b("load")])
  await Promise.all([a("add", "sk_added_A"), b("add", "sk_added_B")])
  assert.deepEqual(
    (await loadPoolFile()).accounts
      .map((a) => a.apiKey)
      .filter(Boolean)
      .sort(),
    ["sk_added_A", "sk_added_B"],
  )
})

test("persistence: peer removal survives a stale save; explicit stale login can revive it", async () => {
  await savePoolFile(oauthPool())
  const a = await worker(),
    b = await worker()
  await Promise.all([a("load"), b("load")])
  await a("remove")
  await b("metadata")
  let disk = await loadPoolFile()
  assert.equal(disk.accounts.length, 0)
  assert.equal(disk.removed?.length, 1)
  await b("revive")
  disk = await loadPoolFile()
  assert.equal(disk.accounts.length, 1)
  assert.equal(disk.removed, undefined)
})

test("persistence: token refresh does not deadlock or drop peer additions", { timeout: 5000 }, async () => {
  await savePoolFile(oauthPool())
  const stale = await worker(),
    peer = await worker()
  await Promise.all([stale("load"), peer("load")])
  await peer("add", "sk_peer_added")
  await stale("refresh")
  const disk = await loadPoolFile()
  assert.equal(disk.accounts.length, 2)
  assert.equal(disk.accounts[0].refresh, "worker-refresh")
})

test("persistence: independent pool objects refresh once and both adopt the result", async () => {
  await savePoolFile(oauthPool())
  const a = await loadPoolFile(),
    b = await loadPoolFile()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return tokenResponse()
  }
  await Promise.all([refreshAccount(a, a.accounts[0], log), refreshAccount(b, b.accounts[0], log)])
  assert.equal(calls, 1)
  assert.equal(a.accounts[0].refresh, "fresh-refresh")
  assert.equal(b.accounts[0].refresh, "fresh-refresh")
})

test("persistence: expired peer rotation uses the peer refresh credential, never the stale one", async () => {
  await savePoolFile(oauthPool())
  const stale = await loadPoolFile(),
    peer = await loadPoolFile()
  peer.accounts[0].access = "expired-peer-access"
  peer.accounts[0].refresh = "expired-peer-refresh"
  await savePoolFile(peer)
  let sent: unknown
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body))
    return tokenResponse()
  }
  await refreshAccount(stale, stale.accounts[0], log)
  assert.equal((sent as { refreshToken: string }).refreshToken, "expired-peer-refresh")
  assert.equal((await loadPoolFile()).accounts[0].refresh, "fresh-refresh")
})

test("persistence: stale credential mutation loses CAS without losing unrelated metadata", async () => {
  await savePoolFile(oauthPool())
  const a = await loadPoolFile(),
    b = await loadPoolFile()
  a.accounts[0].access = "rotated"
  a.accounts[0].refresh = "rotated-refresh"
  await savePoolFile(a)
  b.accounts[0].access = "stale-relogin"
  b.accounts[0].refresh = "stale-refresh"
  b.accounts[0].label = "custom label"
  await savePoolFile(b)
  assert.equal(b.accounts[0].access, "rotated")
  assert.equal(b.accounts[0].refresh, "rotated-refresh")
  assert.equal(b.accounts[0].label, "custom label")
})

test("persistence: concurrent per-model state merges and expired deletions do not erase new cooldowns", async () => {
  await savePoolFile(apiPool())
  const a = await loadPoolFile(),
    b = await loadPoolFile()
  a.accounts[0].modelLimits = { A: 100 }
  b.accounts[0].modelLimits = { B: 200 }
  await Promise.all([savePoolFile(a), savePoolFile(b)])
  assert.deepEqual((await loadPoolFile()).accounts[0].modelLimits, { A: 100, B: 200 })
  const c = await loadPoolFile(),
    d = await loadPoolFile()
  delete c.accounts[0].modelLimits!.A
  d.accounts[0].modelLimits!.A = 300
  await savePoolFile(d)
  await savePoolFile(c)
  assert.equal((await loadPoolFile()).accounts[0].modelLimits!.A, 300)
})

test("persistence: removal and explicit revival work even before the stale pool observes the tombstone", async () => {
  await savePoolFile(apiPool())
  const a = await loadPoolFile(),
    b = await loadPoolFile()
  const [removed] = a.accounts.splice(0, 1)
  rememberRemoval(a, removed.apiKey!)
  await savePoolFile(a)
  forgetRemoval(b, removed.apiKey!)
  upsertApiAccount(b, removed.apiKey!)
  await savePoolFile(b)
  assert.equal((await loadPoolFile()).accounts.length, 2)
})

test("persistence: refresh refuses a peer-removed account without a network request", async () => {
  await savePoolFile(oauthPool())
  const a = await loadPoolFile(),
    stale = await loadPoolFile()
  const [removed] = a.accounts.splice(0, 1)
  rememberRemoval(a, removed.access!)
  await savePoolFile(a)
  await assert.rejects(refreshAccount(stale, stale.accounts[0], log), TerminalAuthError)
  assert.equal(stale.accounts.length, 0)
})

test("persistence: all saves respect the lock; nested storage directories and cleanup work", async () => {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const gate = new Promise<void>((r) => {
    release = r
  })
  const holder = withFileLock(async () => {
    entered()
    await gate
  })
  await ready
  let saved = false
  const saving = savePoolFile(apiPool()).then(() => {
    saved = true
  })
  await flush()
  assert.equal(saved, false)
  release()
  await Promise.all([holder, saving])
  assert.deepEqual(await readdir(join(dir, "nested")), ["pool.json"])
})

test("persistence: corrupt disk state is not overwritten by a save", async () => {
  await savePoolFile(apiPool())
  const pool = await loadPoolFile()
  await writeFile(poolFilePath(), "{broken")
  await assert.rejects(savePoolFile(pool), SyntaxError)
  assert.equal(await readFile(poolFilePath(), "utf8"), "{broken")
})

// 2. Header delivery must not end the authentication timeout.
function timers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
}
function hangingBody(onCancel = () => {}) {
  return new Response(new ReadableStream<Uint8Array>({ cancel: onCancel }))
}

test("auth timeout: stalled headers are bounded even when transport ignores cancellation", async (t) => {
  timers(t)
  globalThis.fetch = () => new Promise(() => {})
  const promise = fetchWithTimeout("https://auth.test", { timeoutMs: 20 })
  const rejected = assert.rejects(promise, TransientAuthError)
  t.mock.timers.tick(20)
  await rejected
})

test("auth timeout: stalled response body is bounded and cancelled after immediate headers", async (t) => {
  timers(t)
  let cancelled = false
  globalThis.fetch = async () =>
    hangingBody(() => {
      cancelled = true
    })
  const promise = fetchWithTimeout("https://auth.test", { timeoutMs: 20 })
  const rejected = assert.rejects(promise, TransientAuthError)
  await flush()
  t.mock.timers.tick(20)
  await rejected
  assert.ok(cancelled)
})

test("auth timeout: caller reason survives abort during body consumption and listeners are removed", async () => {
  const ctrl = new AbortController(),
    reason = new Error("caller cancelled")
  globalThis.fetch = async () => hangingBody()
  const promise = fetchWithTimeout("https://auth.test", { signal: ctrl.signal })
  const rejected = assert.rejects(promise, (e) => e === reason)
  await flush()
  ctrl.abort(reason)
  await rejected
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0)
})

test("auth timeout: pre-aborted calls do not dispatch and completed responses remain readable", async (t) => {
  timers(t)
  const ctrl = new AbortController()
  ctrl.abort(new Error("early"))
  await assert.rejects(fetchWithTimeout("https://auth.test", { signal: ctrl.signal }), /early/)
  globalThis.fetch = async () => new Response('{"ok":true}', { status: 201, headers: { "x-test": "yes" } })
  const res = await fetchWithTimeout("https://auth.test", { timeoutMs: 20 })
  t.mock.timers.tick(100)
  assert.equal(res.status, 201)
  assert.equal(res.headers.get("x-test"), "yes")
  assert.deepEqual(await res.json(), { ok: true })
})

for (const operation of ["refresh", "registration"] as const) {
  test(`auth timeout: ${operation} retries a stalled body, then parses success`, async (t) => {
    timers(t)
    let calls = 0
    globalThis.fetch = async () => (++calls === 1 ? hangingBody() : tokenResponse())
    const pending =
      operation === "refresh" ? refreshClineToken("r") : registerWorkOSTokens({ accessToken: "a", refreshToken: "r" })
    await flush()
    t.mock.timers.tick(AUTH_TIMEOUT_MS)
    await flush()
    t.mock.timers.tick(1000)
    assert.equal((await pending).refresh, "fresh-refresh")
    assert.equal(calls, 2)
  })
}

test("auth timeout: abandoned device login cancels a stalled authentication body", async () => {
  const ctrl = new AbortController()
  globalThis.fetch = async () => hangingBody()
  const promise = pollDeviceAuth("code", 600, 5, ctrl.signal)
  const rejected = assert.rejects(promise, /cancelled|abort/i)
  await flush()
  ctrl.abort()
  await rejected
})

test("inference: response stream is not subject to the auth body deadline", async (t) => {
  timers(t)
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const pool = apiPool()
  const res = await createRoutedFetch(
    pool,
    log,
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            stream = c
          },
        }),
      ),
  )(CHAT, {
    method: "POST",
    headers: { authorization: "Bearer sk_test_primary" },
    body: '{"model":"free"}',
  })
  t.mock.timers.tick(AUTH_TIMEOUT_MS * 2)
  stream.enqueue(new TextEncoder().encode("still streaming"))
  stream.close()
  assert.equal(await res.text(), "still streaming")
})

// 3. Full-token cryptographic fingerprints, not display-token fingerprints.
test("env identity: distinct same-prefix/suffix/length keys cannot share state or credentials", () => {
  const a = "sk_sameAAAA1111tail",
    b = "sk_sameBBBB2222tail"
  process.env.CLINE_API_KEYS = `${a},${b}`
  const pool: PoolFile = { version: 1, accounts: [] }
  const candidates = allCandidates(pool)
  assert.deepEqual(
    candidates.map((a) => a.apiKey),
    [a, b],
  )
  assert.notEqual(candidates[0], candidates[1])
  assert.equal(candidates[0].id, `env-${createHash("sha256").update(a).digest("hex")}`)
  markAccountLimited(pool, candidates[0].id, 60_000, log, undefined, "A")
  candidates[0].authFailedAt = 1
  assert.equal(candidates[1].modelLimits, undefined)
  assert.deepEqual(
    allCandidates(pool).map((a) => a.apiKey),
    [b],
  )
  process.env.CLINE_API_KEYS = `${b},${a}`
  assert.equal(allCandidates(pool)[0], candidates[1], "env order does not change object identity")
})

// 4. True global and model cooldowns are independent, in either update order.
for (const globalFirst of [true, false]) {
  test(`cooldowns: global/model overlap cannot bypass the global limit (${globalFirst ? "global" : "model"} first)`, async () => {
    const pool = apiPool(),
      account = pool.accounts[0]
    const global = () => markAccountLimited(pool, account.id, 60_000, log)
    const model = () => markAccountLimited(pool, account.id, 120_000, log, undefined, "A")
    if (globalFirst) {
      global()
      model()
    } else {
      model()
      global()
    }
    assert.equal(isAvailable(pool, account, Date.now(), "B"), false)
    assert.ok(account.limitedUntil! < account.modelLimits!.A)
    assert.equal(cooldownUntil(account, "A"), account.modelLimits!.A)
    assert.equal(cooldownUntil(account, "B"), account.limitedUntil)
    const now = account.limitedUntil! + 1
    pruneLimits(pool, now)
    assert.equal(isAvailable(pool, account, now, "B"), true)
    assert.equal(isAvailable(pool, account, now, "A"), false)
    assert.match(poolStatusText(pool), /COOLDOWN/)
    await savePoolFile(pool)
    const loaded = await loadPoolFile()
    assert.equal(loaded.accounts[0].limitsVersion, 2)
    assert.equal(loaded.accounts[0].limitedUntil, undefined)
    assert.equal(loaded.accounts[0].modelLimits!.A, account.modelLimits!.A)
  })
}

test("cooldowns: legacy aggregate migrates without blocking other models; legacy distinct global is retained", async () => {
  const pool = apiPool(),
    until = Date.now() + 120_000
  pool.accounts[0].limitedUntil = until
  pool.accounts[0].modelLimits = { A: until }
  pool.accounts[1].limitedUntil = until - 60_000
  pool.accounts[1].modelLimits = { A: until }
  await savePoolFile(pool)
  const loaded = await loadPoolFile()
  assert.equal(isAvailable(loaded, loaded.accounts[0], Date.now(), "B"), true)
  assert.equal(isAvailable(loaded, loaded.accounts[0], Date.now(), "A"), false)
  assert.equal(isAvailable(loaded, loaded.accounts[1], Date.now(), "B"), false)
})

test("cooldowns: router skips a known globally limited initial account even for another model", async () => {
  const pool = apiPool()
  markAccountLimited(pool, "a", 120_000, log, undefined, "A")
  markAccountLimited(pool, "a", 60_000, log)
  const seen: string[] = []
  const fetcher = createRoutedFetch(pool, log, async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization")!)
    return new Response("ok")
  })
  await fetcher(CHAT, { method: "POST", headers: { authorization: "Bearer sk_test_primary" }, body: '{"model":"B"}' })
  assert.deepEqual(seen, ["Bearer sk_test_secondary"])
})

// 5. HTTP classification and parsing must occur inside retries.
for (const status of [429, 503]) {
  test(`device start: HTTP ${status} retries and succeeds`, async (t) => {
    timers(t)
    let calls = 0
    globalThis.fetch = async () =>
      ++calls === 1 ? new Response('{"error":"server_error"}', { status }) : deviceResponse()
    const pending = startDeviceAuth()
    await flush()
    t.mock.timers.tick(1000)
    assert.equal((await pending).deviceCode, "d")
    assert.equal(calls, 2)
  })
}

test("device start: malformed successful body retries; terminal invalid_client does not", async (t) => {
  timers(t)
  let calls = 0
  globalThis.fetch = async () => (++calls === 1 ? new Response("not json") : deviceResponse())
  const pending = startDeviceAuth()
  await flush()
  t.mock.timers.tick(1000)
  assert.equal((await pending).userCode, "u")
  calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('{"error":"invalid_client"}', { status: 400 })
  }
  await assert.rejects(startDeviceAuth(), TerminalAuthError)
  assert.equal(calls, 1)
})

test("device start: cancellation during retry backoff prevents another request", async (t) => {
  timers(t)
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response("busy", { status: 503 })
  }
  const ctrl = new AbortController(),
    reason = new Error("cancel backoff")
  const pending = startDeviceAuth(ctrl.signal)
  const rejected = assert.rejects(pending, (e) => e === reason)
  await flush()
  ctrl.abort(reason)
  await rejected
  t.mock.timers.tick(1000)
  assert.equal(calls, 1)
})

// 6. Fetch normalization must use the effective Request + init, for ALL sends.
test("request overrides: effective method, body, headers and fetch options survive failover", async () => {
  const seen: { method: string; body: string; headers: Headers; init: RequestInit }[] = []
  const routed = createRoutedFetch(apiPool(), log, async (_url, init) => {
    seen.push({
      method: init!.method!,
      body: new TextDecoder().decode(init!.body as ArrayBuffer),
      headers: new Headers(init!.headers),
      init: init!,
    })
    return new Response("{}", { status: seen.length === 1 ? 429 : 200 })
  })
  const original = new Request(CHAT, {
    method: "POST",
    headers: { authorization: "Bearer sk_test_primary", "x-old": "old" },
    body: '{"model":"old"}',
  })
  const res = await routed(original, {
    method: "PUT",
    body: '{"model":"new"}',
    headers: { authorization: "Bearer sk_test_primary", "x-new": "new" },
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
  })
  assert.equal(res.status, 200)
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.equal(call.method, "PUT")
    assert.equal(call.body, '{"model":"new"}')
    assert.equal(call.headers.get("x-old"), null)
    assert.equal(call.headers.get("x-new"), "new")
    assert.equal(call.init.credentials, "omit")
    assert.equal(call.init.redirect, "manual")
    assert.equal(call.init.cache, "no-store")
  }
})

test("request overrides: standard GET default and null body override semantics", async () => {
  const seen: { method?: string; body: string }[] = []
  const routed = createRoutedFetch(apiPool(), log, async (_url, init) => {
    seen.push({ method: init?.method, body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "" })
    return new Response("ok")
  })
  await routed(CHAT)
  const original = new Request(CHAT, { method: "POST", body: "retained" })
  await routed(original, { body: null })
  assert.deepEqual(seen, [
    { method: "GET", body: "" },
    { method: "POST", body: "retained" },
  ])
  await assert.rejects(routed(new Request(CHAT, { method: "POST", body: "body" }), { method: "GET" }), TypeError)
  assert.equal(seen.length, 2)
})

test("request overrides: replacement signal overrides the Request signal, including streamed response cancellation", async () => {
  const old = new AbortController(),
    current = new AbortController()
  old.abort()
  let received!: AbortSignal
  const routed = createRoutedFetch(apiPool(), log, async (_url, init) => {
    received = init!.signal!
    return new Response("ok")
  })
  await routed(new Request(CHAT, { signal: old.signal }), { signal: current.signal })
  assert.equal(received.aborted, false)
  const reason = new Error("new signal")
  current.abort(reason)
  assert.equal(received.reason, reason)
})

test("request overrides: cancellation during Request body buffering does not dispatch", async () => {
  const ctrl = new AbortController()
  let calls = 0,
    cancelled = false
  const request = new Request(CHAT, {
    method: "POST",
    body: new ReadableStream({
      cancel() {
        cancelled = true
      },
    }),
    duplex: "half",
  } as RequestInit)
  const routed = createRoutedFetch(apiPool(), log, async () => {
    calls++
    return new Response("ok")
  })
  const pending = routed(request, { signal: ctrl.signal })
  const reason = new Error("stop buffering")
  const rejected = assert.rejects(pending, (e) => e === reason)
  await flush()
  ctrl.abort(reason)
  await rejected
  assert.equal(calls, 0)
  assert.ok(cancelled)
})

test("request overrides: explicit streaming init body is single-shot pass-through", async () => {
  const body = new ReadableStream({
    start(c) {
      c.close()
    },
  })
  const init = { method: "POST", body, duplex: "half" } as RequestInit
  let calls = 0
  const routed = createRoutedFetch(apiPool(), log, async (input, received) => {
    calls++
    assert.equal(input, CHAT)
    assert.equal(received, init)
    return new Response("busy", { status: 429 })
  })
  assert.equal((await routed(CHAT, init)).status, 429)
  assert.equal(calls, 1)
})

// 7. Credential rewriting must never extend to lookalike origins/paths.
test("routable URL: exact origin and completion endpoint boundaries only", () => {
  for (const good of [CHAT, `${CHAT}/`, `${CHAT}?stream=true`, "https://API.CLINE.BOT:443/api/v1/completions"])
    assert.equal(isRoutableUrl(good), true, good)
  for (const bad of [
    "https://api.cline.bot.attacker.example/api/v1/chat/completions",
    "https://api.cline.bot@attacker.example/api/v1/chat/completions",
    "https://attacker.example@api.cline.bot/api/v1/chat/completions",
    "https://api.cline.bot:444/api/v1/chat/completions",
    "http://api.cline.bot/api/v1/chat/completions",
    `${CHAT}/evil`,
    `${CHAT}-extra`,
    "https://api.cline.bot/evil/completions",
    "https://api.cline.bot/api/v1/users/me?next=/chat/completions",
    "https://api.cline.bot/api/v1/chat%2fcompletions",
    "not a URL",
  ])
    assert.equal(isRoutableUrl(bad), false, bad)
})

test("routable URL: lookalike host remains untouched and never receives pooled credentials", async () => {
  const input = "https://api.cline.bot.attacker.example/api/v1/chat/completions"
  const init = { method: "POST", body: "{}", headers: { "x-test": "original" } }
  let calls = 0
  const routed = createRoutedFetch(apiPool(), log, async (url, received) => {
    calls++
    assert.equal(url, input)
    assert.equal(received, init)
    assert.equal(new Headers(received?.headers).has("authorization"), false)
    return new Response("busy", { status: 429 })
  })
  assert.equal((await routed(input, init)).status, 429)
  assert.equal(calls, 1)
})

test("persistence: simultaneous stale-lock reapers cannot break a successor's lock", async () => {
  await savePoolFile(oauthPool())
  const a = await worker(),
    b = await worker()
  await Promise.all([a("load"), b("load")])
  const lock = `${poolFilePath()}.lock`
  await mkdir(lock)
  const owner = `${lock}/owner-2147483647-dead-beef`
  await writeFile(owner, "2147483647")
  const old = new Date(0)
  await utimes(owner, old, old)
  await Promise.all([a("add", "sk_reaped_A"), b("add", "sk_reaped_B")])
  assert.equal((await loadPoolFile()).accounts.length, 3)
  assert.deepEqual(await readdir(join(dir, "nested")), ["pool.json"])
})

test("persistence: dead legacy lockfiles are recoverable", async () => {
  await savePoolFile(apiPool())
  const lock = `${poolFilePath()}.lock`
  await writeFile(lock, "2147483647")
  await utimes(lock, new Date(0), new Date(0))
  const pool = await loadPoolFile()
  pool.accounts[0].label = "recovered"
  await savePoolFile(pool)
  assert.equal((await loadPoolFile()).accounts[0].label, "recovered")
})

test("persistence: refresh preserves a peer's unchanged-in-this-process label", async () => {
  await savePoolFile(oauthPool())
  const stale = await loadPoolFile(),
    peer = await loadPoolFile()
  peer.accounts[0].label = "peer label"
  await savePoolFile(peer)
  globalThis.fetch = async () => tokenResponse()
  await refreshAccount(stale, stale.accounts[0], log)
  assert.equal((await loadPoolFile()).accounts[0].label, "peer label")
})

test("persistence: simultaneous subprocess refreshes rotate exactly once", async () => {
  await savePoolFile(oauthPool())
  const a = await worker(),
    b = await worker()
  await Promise.all([a("load"), b("load")])
  const results = await Promise.all([a("refresh"), b("refresh")])
  assert.equal(
    results.reduce((sum, r) => sum + r.refreshCalls, 0),
    1,
  )
  assert.equal((await loadPoolFile()).accounts[0].refresh, "worker-refresh")
})

test("persistence: a locally updated credential is not replaced by unchanged disk credentials during forced refresh", async () => {
  const pool = oauthPool()
  pool.accounts[0].expires = 4_000_000_000_000
  await savePoolFile(pool)
  const local = await loadPoolFile()
  local.accounts[0].access = "local-login-access"
  local.accounts[0].refresh = "local-login-refresh"
  let sent: unknown
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body))
    return tokenResponse()
  }
  await refreshAccount(local, local.accounts[0], log)
  assert.equal((sent as { refreshToken: string }).refreshToken, "local-login-refresh")
  assert.equal((await loadPoolFile()).accounts[0].refresh, "fresh-refresh")
})

test("inference: a successful retry stream stays untimed and still follows caller cancellation", async (t) => {
  timers(t)
  let calls = 0,
    signal!: AbortSignal
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const ctrl = new AbortController()
  const routed = createRoutedFetch(apiPool(), log, async (_url, init) => {
    calls++
    if (calls === 1) return new Response("busy", { status: 429 })
    signal = init!.signal!
    return new Response(
      new ReadableStream({
        start(c) {
          stream = c
        },
      }),
    )
  })
  const response = await routed(CHAT, {
    method: "POST",
    headers: { authorization: "Bearer sk_test_primary" },
    body: '{"model":"free"}',
    signal: ctrl.signal,
  })
  t.mock.timers.tick(300_000)
  assert.equal(signal.aborted, false)
  const reason = new Error("stop inference")
  ctrl.abort(reason)
  assert.equal(signal.reason, reason)
  stream.enqueue(new TextEncoder().encode("alive"))
  stream.close()
  assert.equal(await response.text(), "alive")
})

test("cooldowns: pruning model-only cooldowns clears their stale 429 error", () => {
  const pool = apiPool(),
    a = pool.accounts[0]
  markAccountLimited(pool, a.id, 60_000, log, undefined, "A")
  assert.equal(a.limitedUntil, undefined)
  const end = a.modelLimits!.A
  assert.ok(a.lastError)
  assert.equal(pruneLimits(pool, end + 1), true)
  assert.equal(a.modelLimits, undefined)
  assert.equal(a.lastError, undefined)
})
