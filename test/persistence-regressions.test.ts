import { test, beforeEach, afterEach, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PoolFile,
  clearAuthHealth,
  forgetRemoval,
  loadPoolFile,
  poolFilePath,
  refreshAccount,
  rememberRemoval,
  savePoolFile,
  upsertApiAccount,
  upsertOAuthAccount,
} from "../src/core/pool.ts"

const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises")
const realFetch = globalThis.fetch
const oldFile = process.env.CLINE_FREE_ACCOUNTS_FILE
const log = () => {}
const jwt = (session: string) => `header.${Buffer.from(JSON.stringify({ sub: "persistence-user", sid: session })).toString("base64url")}.signature`
const creds = (session: string, expires = 4_000_000_000_000) => ({ access: jwt(session), refresh: `${session}-refresh`, expires })
const tokenResponse = () => new Response(JSON.stringify({
  success: true,
  data: { accessToken: jwt("refreshed"), refreshToken: "refreshed-refresh", expiresAt: "2090-01-01T00:00:00Z" },
}))
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cline-persistence-regressions-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "pool.json")
  globalThis.fetch = async () => { throw new Error("live network disabled in persistence tests") }
})
afterEach(async () => {
  globalThis.fetch = realFetch
  if (oldFile === undefined) delete process.env.CLINE_FREE_ACCOUNTS_FILE
  else process.env.CLINE_FREE_ACCOUNTS_FILE = oldFile
  await rm(dir, { recursive: true, force: true })
})

async function seed(refresh: string | undefined = "old-refresh") {
  const pool: PoolFile = {
    version: 1,
    activeId: "oauth",
    accounts: [{ id: "oauth", ...creds("old", 1), refresh, source: "oauth", addedAt: 1, label: "Original custom label" }],
  }
  await writeFile(poolFilePath(), JSON.stringify(pool))
  return { local: await loadPoolFile(), peer: await loadPoolFile() }
}

// Pause exactly one disk read while save owns the real file mutex. No sleeps or
// scheduler guesses: refresh/login is started only after save reached that read.
function gatePoolRead(t: TestContext) {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = fs.readFile
  let first = true
  const mocked = t.mock.method(fs, "readFile", async (...args: any[]) => {
    if (first && args[0] === poolFilePath()) {
      first = false
      entered()
      await gate
    }
    return Reflect.apply(original, fs, args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    release()
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  return { ready, release }
}

for (const expiry of [1, 4_000_000_000_000]) {
  test(`persistence: queued save rebases refresh before token selection (peer expiry ${expiry})`, { timeout: 5000 }, async (t) => {
    const { local, peer } = await seed()
    Object.assign(peer.accounts[0], creds("peer", expiry))
    peer.accounts[0].label = "Peer updated label"
    upsertApiAccount(peer, "sk_peer_added")
    await savePoolFile(peer)
    const account = local.accounts[0]
    account.lastUsed = 123
    account.authFailedAt = 42 // An obsolete health report must not follow rotation.
    const gate = gatePoolRead(t)
    const saving = savePoolFile(local)
    await gate.ready
    const sent: string[] = []
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).refreshToken)
      return tokenResponse()
    }
    const refreshing = refreshAccount(local, account, log)
    gate.release()
    await Promise.all([saving, refreshing])
    assert.deepEqual(sent, ["peer-refresh"], "refresh must read the reconciled account, not its pre-lock token")
    assert.equal(local.accounts[0], account, "adoption must retain live references")
    const disk = await loadPoolFile()
    assert.equal(disk.accounts[0].refresh, "refreshed-refresh")
    assert.equal(account.refresh, "refreshed-refresh")
    assert.equal(disk.accounts[0].label, "Peer updated label")
    assert.equal(disk.accounts[0].lastUsed, 123)
    assert.equal(disk.accounts[0].authFailedAt, undefined)
    assert.equal(disk.accounts[1].apiKey, "sk_peer_added")
  })
}

test("persistence: queued save may supply a missing refresh token before refresh locks", { timeout: 5000 }, async (t) => {
  const { local, peer } = await seed()
  delete local.accounts[0].refresh
  Object.assign(peer.accounts[0], creds("peer", 1))
  await savePoolFile(peer)
  const gate = gatePoolRead(t)
  const saving = savePoolFile(local)
  await gate.ready
  const sent: string[] = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).refreshToken)
    return tokenResponse()
  }
  const refreshing = refreshAccount(local, local.accounts[0], log)
  // Install the rejection observer before releasing the save, even on broken code.
  const completed = Promise.allSettled([saving, refreshing])
  gate.release()
  const results = await completed
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"])
  assert.deepEqual(sent, ["peer-refresh"])
  assert.equal((await loadPoolFile()).accounts[0].refresh, "refreshed-refresh")
})

for (const health of ["quarantine", "cooldown"] as const) {
  test(`persistence: peer adoption rebases subsequent current-token ${health} without rebasing unrelated metadata`, async () => {
    const { local, peer } = await seed()
    const account = local.accounts[0]
    account.authFailedAt = 10
    account.authFailedReason = "obsolete session"
    Object.assign(peer.accounts[0], creds("peer"))
    peer.accounts[0].label = "Peer updated label"
    upsertApiAccount(peer, "sk_peer_added")
    await savePoolFile(peer)
    await refreshAccount(local, account, log) // A fresh peer must avoid the network.
    assert.equal(account.refresh, "peer-refresh")
    assert.equal(account.authFailedAt, undefined)
    if (health === "quarantine") {
      account.authFailedAt = 1234
      account.authFailedReason = "invalid current token"
      account.lastProbeAt = 1235
    } else {
      account.limitedUntil = 4_000_000_000_001
      account.modelLimits = { current: 4_000_000_000_002 }
    }
    account.lastError = `current-token ${health}`
    account.lastUsed = 456
    await savePoolFile(local)
    const disk = await loadPoolFile()
    assert.equal(disk.accounts[0].lastError, `current-token ${health}`)
    assert.equal(account.lastError, `current-token ${health}`)
    assert.equal(disk.accounts[0].authFailedAt, health === "quarantine" ? 1234 : undefined)
    assert.equal(disk.accounts[0].authFailedReason, health === "quarantine" ? "invalid current token" : undefined)
    assert.equal(disk.accounts[0].lastProbeAt, health === "quarantine" ? 1235 : undefined)
    assert.equal(disk.accounts[0].limitedUntil, health === "cooldown" ? 4_000_000_000_001 : undefined)
    assert.deepEqual(disk.accounts[0].modelLimits, health === "cooldown" ? { current: 4_000_000_000_002 } : undefined)
    assert.equal(disk.accounts[0].label, "Peer updated label", "credential rebase must not claim unread peer metadata")
    assert.equal(disk.accounts[0].lastUsed, 456)
    assert.equal(disk.accounts[0].refresh, "peer-refresh")
    assert.equal(disk.accounts[1].apiKey, "sk_peer_added")

    // The rebase is not a permanent CAS bypass: health for this token becomes
    // stale again as soon as another peer rotates it.
    Object.assign(disk.accounts[0], creds("next-peer"))
    clearAuthHealth(disk.accounts[0])
    await savePoolFile(disk)
    account.lastError = "obsolete again"
    account.authFailedAt = 9999
    account.modelLimits = { obsolete: 4_000_000_000_003 }
    account.lastUsed = 789
    await savePoolFile(local)
    const final = (await loadPoolFile()).accounts[0]
    assert.equal(final.refresh, "next-peer-refresh")
    assert.equal(final.authFailedAt, undefined)
    assert.equal(final.modelLimits, undefined)
    assert.equal(final.lastError, undefined)
    assert.equal(final.lastUsed, 789)
  })
}

test("persistence: explicit fresh login replaces a peer rotation and its health, but not peer metadata", async () => {
  const { local, peer } = await seed()
  const account = local.accounts[0]
  Object.assign(peer.accounts[0], creds("peer"), {
    label: "Peer updated label",
    limitsVersion: 2,
    authFailedAt: 12,
    authFailedReason: "peer session invalid",
    lastProbeAt: 13,
    limitedUntil: 4_000_000_000_001,
    modelLimits: { capped: 4_000_000_000_002 },
    lastError: "peer auth error",
  })
  upsertApiAccount(peer, "sk_peer_added")
  await savePoolFile(peer)
  // A fresh login is authoritative even if its expiry is shorter than peer's.
  forgetRemoval(local, jwt("login"))
  assert.equal(upsertOAuthAccount(local, creds("login", 3_000_000_000_000)), account)
  await savePoolFile(local)
  const disk = await loadPoolFile()
  assert.equal(account.access, jwt("login"))
  assert.equal(account.refresh, "login-refresh")
  assert.equal(account.expires, 3_000_000_000_000)
  assert.equal(disk.accounts[0].access, jwt("login"))
  assert.equal(disk.accounts[0].refresh, "login-refresh")
  assert.equal(disk.accounts[0].expires, 3_000_000_000_000)
  for (const key of ["authFailedAt", "authFailedReason", "lastProbeAt", "limitedUntil", "modelLimits", "lastError"] as const) {
    assert.equal(disk.accounts[0][key], undefined, `${key} belongs to the replaced session`)
  }
  assert.equal(disk.accounts[0].label, "Peer updated label")
  assert.equal(disk.accounts[1].apiKey, "sk_peer_added")

  Object.assign(disk.accounts[0], creds("next-peer"))
  await savePoolFile(disk)
  account.authFailedAt = 123
  account.modelLimits = { stale: 4_000_000_000_001 }
  account.lastUsed = 789
  await savePoolFile(local)
  const final = (await loadPoolFile()).accounts[0]
  assert.equal(final.refresh, "next-peer-refresh", "login intent must be consumed after its successful save")
  assert.equal(final.authFailedAt, undefined)
  assert.equal(final.modelLimits, undefined)
  assert.equal(final.lastUsed, 789)
})

test("persistence: a background upsert without explicit login cannot overwrite a peer rotation", async () => {
  const { local, peer } = await seed()
  Object.assign(peer.accounts[0], creds("peer"))
  await savePoolFile(peer)
  upsertOAuthAccount(local, creds("stale-host"))
  local.accounts[0].authFailedAt = 123
  local.accounts[0].lastUsed = 456
  await savePoolFile(local)
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].refresh, "peer-refresh")
  assert.equal(disk.accounts[0].authFailedAt, undefined)
  assert.equal(disk.accounts[0].lastUsed, 456)
})

test("persistence: explicit OAuth login revives peer removal with new credentials", async () => {
  const { local, peer } = await seed()
  Object.assign(peer.accounts[0], creds("peer"))
  const [removed] = peer.accounts.splice(0, 1)
  rememberRemoval(peer, removed.access!)
  await savePoolFile(peer)
  forgetRemoval(local, jwt("login"))
  upsertOAuthAccount(local, creds("login"))
  await savePoolFile(local)
  const disk = await loadPoolFile()
  assert.equal(disk.accounts.length, 1)
  assert.equal(disk.accounts[0].refresh, "login-refresh")
  assert.equal(disk.removed, undefined)
})

test("persistence: a second explicit login during save keeps its own replacement intent", { timeout: 5000 }, async (t) => {
  const { local } = await seed()
  forgetRemoval(local, jwt("login-1"))
  upsertOAuthAccount(local, creds("login-1"))
  const gate = gatePoolRead(t)
  const saving = savePoolFile(local)
  await gate.ready
  forgetRemoval(local, jwt("login-2"))
  upsertOAuthAccount(local, creds("login-2"))
  gate.release()
  await saving
  assert.equal(local.accounts[0].refresh, "login-2-refresh", "in-flight mutations must survive adoption")
  const disk = await loadPoolFile()
  assert.equal(disk.accounts[0].refresh, "login-1-refresh", "first save must commit only its snapshot")
  Object.assign(disk.accounts[0], creds("peer"))
  disk.accounts[0].label = "Peer updated label"
  await savePoolFile(disk)
  await savePoolFile(local)
  const final = (await loadPoolFile()).accounts[0]
  assert.equal(final.refresh, "login-2-refresh", "the first save must not consume the later login's authority")
  assert.equal(final.label, "Peer updated label")
})
