import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mergeNativeAuth, resolveActiveToken } from "../src/core/account.ts"
import { poolStatusText, removeAccount } from "../src/core/tools.ts"
import type { Logger, PoolFile } from "../src/core/pool.ts"
import plugin from "../src/index.ts"

const log: Logger = () => {}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cline-free-core-"))
  process.env.CLINE_FREE_ACCOUNTS_FILE = join(dir, "accounts.json")
  process.env.CLINE_FREE_MODELS_FILE = join(dir, "models.json")
  for (const k of Object.keys(process.env)) if (/^CLINE(_FREE)?_API_KEY/.test(k)) delete process.env[k]
})

const emptyPool = (): PoolFile => ({ version: 1, accounts: [] })

test("entrypoint keeps the V1 object shape", () => {
  assert.equal(plugin.id, "cline-free")
  assert.equal(typeof plugin.server, "function")
})

test("resolveActiveToken returns undefined for an empty pool", async () => {
  assert.equal(await resolveActiveToken(emptyPool(), log), undefined)
})

test("mergeNativeAuth adds an api key once and resolveActiveToken marks it active", async () => {
  const pool = emptyPool()
  mergeNativeAuth(pool, { type: "api", key: "sk_test_native" })
  mergeNativeAuth(pool, { type: "api", key: "sk_test_native" })
  assert.equal(pool.accounts.length, 1)
  const token = await resolveActiveToken(pool, log)
  assert.equal(token, "sk_test_native")
  assert.equal(pool.activeId, pool.accounts[0].id)
  assert.ok(pool.accounts[0].lastUsed)
})

test("mergeNativeAuth ignores missing or blank credentials", () => {
  const pool = emptyPool()
  mergeNativeAuth(pool, undefined)
  mergeNativeAuth(pool, { type: "api", key: "   " })
  assert.equal(pool.accounts.length, 0)
})

test("poolStatusText and removeAccount", async () => {
  const pool = emptyPool()
  assert.match(poolStatusText(pool), /no accounts/)
  mergeNativeAuth(pool, { type: "api", key: "sk_test_x" })
  const id = pool.accounts[0].id
  assert.match(poolStatusText(pool), new RegExp(id))
  assert.match(await removeAccount(pool, "nope", log), /No stored account/)
  assert.match(await removeAccount(pool, id, log), /Removed/)
  assert.equal(pool.accounts.length, 0)
})
