import { createHash, randomUUID } from "node:crypto"
import { refreshClineToken, validateClineToken } from "./auth.ts"
import { ACCOUNTS_FILE_NAME, API_BASE, REFRESH_BUFFER_MS } from "./constants.ts"
import { TerminalAuthError, TransientAuthError, fetchWithTimeout, sleep, withWorkOSPrefix } from "./http.ts"
import { isPaidModel } from "./models.ts"

// --- Multi-account pool + 429 router ---
//
// Why a pool file: OpenCode keeps exactly one Auth per provider id, so a
// second `/connect` would overwrite the first. Every successful login
// (oauth device flow, CLI import, manual token) is therefore APPENDED to
// the pool, and the loader + fetch wrapper rotate across it.

export type AccountSource = "oauth" | "api" | "env" | "cli"

export type PoolAccount = {
  id: string
  label?: string
  /** Raw Cline access token (no workos: prefix required; added on use). */
  access?: string
  refresh?: string
  expires?: number
  /** Raw token for api/env accounts. */
  apiKey?: string
  source: AccountSource
  addedAt: number
  /** Version 2 separates global cooldowns from per-model cooldowns. */
  limitsVersion?: 2
  /** True account-wide cooldown; never a per-model aggregate. */
  limitedUntil?: number
  /** Per-model 429 cooldowns: Cline's free caps are per user+model, so an
   * account exhausted on deepseek still has muse quota (and vice versa). */
  modelLimits?: Record<string, number>
  lastUsed?: number
  lastError?: string
  /** Terminal auth failure (e.g. invalid_grant): excluded from rotation
   * until re-login clears it or a validation probe recovers it. */
  authFailedAt?: number
  authFailedReason?: string
  lastProbeAt?: number
}

export type PoolFile = {
  version: 1
  activeId?: string
  accounts: PoolAccount[]
  /** Hashed identities removed with cline_free_remove. OpenCode keeps its own
   * copy of the active connection, so without this the next request (or the
   * next host-driven refresh) would copy a removed account straight back in.
   * An explicit login for the same user clears the entry. */
  removed?: string[]
}

/** Per-model 429 cooldowns make selectAccount model-aware: the router
 * extracts the model from the chat body and picks an account that still
 * has quota for THAT model. */
export function modelOfRequest(url: string, body: ArrayBuffer | null): string | undefined {
  if (!body || !url.includes("/chat/completions")) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body))
    const m = parsed?.model
    return typeof m === "string" && m.trim() ? m.trim() : undefined
  } catch {
    return undefined
  }
}

/** ms epoch when this account's cooldown for `model` ends, if any. */
export function modelLimitUntil(acc: PoolAccount, model: string | undefined): number | undefined {
  if (!model || !acc.modelLimits) return undefined
  const until = acc.modelLimits[model]
  return typeof until === "number" ? until : undefined
}

export function poolFilePath(): string {
  const override = process.env.CLINE_FREE_ACCOUNTS_FILE?.trim()
  if (override) return override
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const dataDir =
    process.env.XDG_DATA_HOME?.trim() ||
    (home ? `${home}/.local/share/opencode` : "")
  if (dataDir) return `${dataDir}/${ACCOUNTS_FILE_NAME}`
  return `./${ACCOUNTS_FILE_NAME}`
}

export function stripWorkOSPrefix(token: string): string {
  return token.trim().replace(/^workos:/i, "")
}

export function sameToken(a: string, b: string): boolean {
  return stripWorkOSPrefix(a) === stripWorkOSPrefix(b)
}

/** Same Cline user (stable identity), even across token rotations. */
export function sameAccount(a: string, b: string): boolean {
  const ka = clineUserKey(a)
  const kb = clineUserKey(b)
  if (ka && kb) return ka === kb
  return sameToken(a, b)
}

// --- Stable Cline user identity (dedupe key) ---
//
// OAuth access tokens are short-lived JWTs: every /connect login and every
// refresh mints a NEW token string for the SAME Cline user (same
// external_id/sub, new sid/jti). Deduping by exact token therefore creates
// a duplicate pool entry per login even though quota is per user.
// Decode the JWT payload (no verification — identity hint only) and use
// external_id → sub → email as the stable key, with email-label fallback.
export function b64UrlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  const g = globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } }; atob?: (s: string) => string }
  if (g.Buffer) return g.Buffer.from(padded, "base64").toString("utf8")
  if (typeof g.atob === "function") {
    const bin = g.atob(padded)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  throw new Error("no base64 decoder available")
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const raw = stripWorkOSPrefix(token).trim()
    const parts = raw.split(".")
    if (parts.length < 2 || !parts[1]) return undefined
    return JSON.parse(b64UrlDecodeToString(parts[1])) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function clineUserKey(token: string): string | undefined {
  const p = decodeJwtPayload(token)
  if (!p) return undefined
  const ext = typeof p.external_id === "string" ? p.external_id.trim() : ""
  if (ext) return `ext:${ext}`
  const sub = typeof p.sub === "string" ? p.sub.trim() : ""
  if (sub) return `sub:${sub}`
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : ""
  if (email.includes("@")) return `email:${email}`
  return undefined
}

export function payloadEmail(token: string): string | undefined {
  const p = decodeJwtPayload(token)
  const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : ""
  return email.includes("@") ? email : undefined
}

export function normalizeEmailLabel(label?: string): string | undefined {
  if (!label) return undefined
  const t = label.trim().toLowerCase()
  return t.includes("@") ? t : undefined
}

export function accountEmail(a: PoolAccount): string | undefined {
  return normalizeEmailLabel(a.label) ?? (tokenOf(a) ? payloadEmail(tokenOf(a)!) : undefined)
}

export function freshnessOf(a: PoolAccount): number {
  return Math.max(a.expires ?? 0, a.lastUsed ?? 0, a.addedAt ?? 0)
}

export function isGenericLabel(label?: string): boolean {
  if (!label) return true
  const t = label.trim()
  if (!t) return true
  if (t.includes("@")) return false
  return /^(cline-\d+|token-…|token-|connect-token|account-\d+)$/i.test(t) || t.length <= 8
}

export function maskToken(token: string): string {
  const t = stripWorkOSPrefix(token)
  if (t.length <= 10) return "…"
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

export function newAccountId(): string {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function nextUtcMidnightMs(now = Date.now(), bufferMs = 5 * 60 * 1000): number {
  const d = new Date(now)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime() + bufferMs
}

export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.("retry-after")
  if (raw) {
    const secs = Number(raw.trim())
    if (Number.isFinite(secs) && secs >= 0 && secs <= 48 * 3600) return secs * 1000
    const date = Date.parse(raw.trim())
    if (!Number.isNaN(date)) {
      const delta = date - Date.now()
      if (delta > 0 && delta <= 48 * 3600 * 1000) return delta
    }
  }
  return undefined
}

/** Cline's INFERENCE_CAP bodies carry "Try again in 1h 37m" (no
 * Retry-After header): parse it so per-model cooldowns match the server. */
export function parseRetryAfterFromBody(detail: string | undefined): number | undefined {
  if (!detail) return undefined
  const m = /try again in\s*(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?/i.exec(detail)
  if (!m) return undefined
  const d = Number(m[1] ?? 0)
  const h = Number(m[2] ?? 0)
  const min = Number(m[3] ?? 0)
  const total = (d * 24 + h) * 3600_000 + min * 60_000
  if (total <= 0 || total > 48 * 3600_000) return undefined
  return total
}

export function isRoutableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === API_BASE && !parsed.username && !parsed.password &&
      /^\/api\/v1\/(?:chat\/)?completions\/?$/.test(parsed.pathname)
  } catch {
    return false
  }
}

/** True when a 401/403 body looks like a dead session (not a permission /
 * retired-model error). 401 is always treated as auth; 403 only when the
 * body says so, so real 403s (no access to resource) stay visible. */
export function isAuthFailure(status: number, snippet: string): boolean {
  if (status === 401) return true
  if (status !== 403) return false
  return /unauthor|re-authenticate|reauthenticate|invalid_grant|invalid_token|expired|please .* (login|authenticate)/i.test(
    snippet,
  )
}

// A baseline records what THIS pool last read/committed, not what some other
// process wrote. Save only the delta against it under the same mutex as token
// refresh. Thus a metadata save can never write an unchanged stale credential.
const baselines = new WeakMap<PoolFile, PoolFile>()
// Each explicit login has its own intent, even for the same identity. A save
// must not consume a newer login that arrived while its snapshot was in I/O.
const revivals = new WeakMap<PoolFile, Map<string, symbol>>()
const copy = <T,>(value: T): T => structuredClone(value)
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const emptyPool = (): PoolFile => ({ version: 1, accounts: [] })

async function readPoolFile(file: string): Promise<PoolFile> {
  const { readFile } = await import("node:fs/promises")
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyPool()
    throw e
  }
  const data = JSON.parse(raw) as Partial<PoolFile>
  const accounts = Array.isArray(data.accounts)
    ? data.accounts.filter(
        (a): a is PoolAccount =>
          !!a && typeof a.id === "string" && (typeof a.access === "string" || typeof a.apiKey === "string"),
      )
    : []
  for (const a of accounts) migrateLimits(a)
  const removed = Array.isArray(data.removed) ? data.removed.filter((r): r is string => typeof r === "string") : []
  return {
    version: 1,
    activeId: typeof data.activeId === "string" ? data.activeId : undefined,
    accounts,
    ...(removed.length ? { removed } : {}),
  }
}

export async function loadPoolFile(): Promise<PoolFile> {
  let pool: PoolFile
  try {
    pool = await readPoolFile(poolFilePath())
  } catch {
    pool = emptyPool()
  }
  baselines.set(pool, copy(pool))
  return pool
}

const credentialKeys = ["access", "apiKey", "refresh", "expires"] as const
const healthKeys = new Set([
  "limitedUntil",
  "modelLimits",
  "lastError",
  "authFailedAt",
  "authFailedReason",
  "lastProbeAt",
])
const credentials = (a: PoolAccount) => credentialKeys.map((k) => a[k])

/** Observing peer credentials does not mean we observed its other metadata. */
function rebaseCredentials(pool: PoolFile, peer: PoolAccount): void {
  const baseline = copy(baselines.get(pool) ?? emptyPool())
  const observed = baseline.accounts.find((a) => a.id === peer.id)
  if (observed) {
    for (const k of credentialKeys) {
      if (peer[k] === undefined) delete observed[k]
      else (observed as Record<string, unknown>)[k] = peer[k]
    }
  } else baseline.accounts.push(copy(peer))
  baselines.set(pool, baseline)
}

/** Three-way merge. Credentials are an atomic compare-and-swap group; stale
 * health reports for a replaced credential are ignored. An explicit login
 * replaces credentials and their health as a unit, not unrelated metadata.
 * Model entries merge independently, and deletion applies only to a value we
 * actually observed. */
function mergeAccount(base: PoolAccount, local: PoolAccount, disk: PoolAccount, explicitLogin: boolean): PoolAccount {
  const result = copy(disk)
  const peerRotated = !equal(credentials(base), credentials(disk))
  if (explicitLogin || (!peerRotated && !equal(credentials(base), credentials(local)))) {
    for (const k of explicitLogin ? [...credentialKeys, ...healthKeys] : credentialKeys) {
      const value = (local as Record<string, unknown>)[k]
      if (value === undefined) delete (result as Record<string, unknown>)[k]
      else (result as Record<string, unknown>)[k] = copy(value)
    }
  }
  for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (credentialKeys.includes(k as (typeof credentialKeys)[number]) || k === "id") continue
    if ((peerRotated || explicitLogin) && healthKeys.has(k)) continue
    const b = (base as Record<string, unknown>)[k]
    const l = (local as Record<string, unknown>)[k]
    if (equal(b, l)) continue
    if (k === "modelLimits") {
      const merged = { ...disk.modelLimits }
      for (const m of new Set([...Object.keys(base.modelLimits ?? {}), ...Object.keys(local.modelLimits ?? {})])) {
        const before = base.modelLimits?.[m],
          after = local.modelLimits?.[m]
        if (before === after) continue
        if (after !== undefined) merged[m] = Math.max(merged[m] ?? 0, after)
        else if (merged[m] === before) delete merged[m]
      }
      if (Object.keys(merged).length) result.modelLimits = merged
      else delete result.modelLimits
    } else if (l === undefined) {
      if (equal((disk as Record<string, unknown>)[k], b)) delete (result as Record<string, unknown>)[k]
    } else if (k === "lastUsed" || k === "limitedUntil") {
      ;(result as Record<string, unknown>)[k] = Math.max(Number((disk as Record<string, unknown>)[k]) || 0, Number(l))
    } else {
      ;(result as Record<string, unknown>)[k] = copy(l)
    }
  }
  return result
}

function mergePool(base: PoolFile, local: PoolFile, disk: PoolFile, revived = new Map<string, symbol>()): PoolFile {
  const result = copy(disk)
  const removed = new Set(disk.removed)
  for (const r of base.removed ?? []) if (!local.removed?.includes(r)) removed.delete(r)
  for (const r of revived.keys()) removed.delete(r)
  for (const r of local.removed ?? []) if (!base.removed?.includes(r)) removed.add(r)
  result.removed = [...removed].slice(-MAX_REMOVED)
  if (!result.removed.length) delete result.removed
  const before = new Map(base.accounts.map((a) => [a.id, a]))
  const after = new Map(local.accounts.map((a) => [a.id, a]))
  // Explicit deletions remove only records present in our baseline. A stale
  // snapshot missing a peer's newly added account is NOT a deletion.
  result.accounts = result.accounts.filter((a) => !(before.has(a.id) && !after.has(a.id)))
  for (const a of local.accounts) {
    const old = before.get(a.id)
    const idx = result.accounts.findIndex((d) => d.id === a.id)
    if (old) {
      if (idx >= 0) result.accounts[idx] = mergeAccount(old, a, result.accounts[idx], revived.has(identityHash(tokenOf(a) ?? "")))
      else if (revived.has(identityHash(tokenOf(a) ?? ""))) result.accounts.push(copy(a))
      // Only an explicit login may resurrect a record removed by a peer.
    } else if (idx < 0) {
      const token = tokenOf(a)
      if (!token || !removed.has(identityHash(token))) result.accounts.push(copy(a))
    }
  }
  result.accounts = result.accounts.filter((a) => !isRemoved(result, tokenOf(a) ?? ""))
  if (local.activeId !== base.activeId) result.activeId = local.activeId
  if (!result.accounts.some((a) => a.id === result.activeId)) result.activeId = result.accounts[0]?.id
  return result
}

/** Adopt peer state without replacing live account objects held by callers. */
function adoptPool(pool: PoolFile, next: PoolFile): void {
  const existing = new Map(pool.accounts.map((a) => [a.id, a]))
  pool.accounts = next.accounts.map((a) => {
    const current = existing.get(a.id)
    if (!current) return a
    for (const k of Object.keys(current)) delete (current as Record<string, unknown>)[k]
    Object.assign(current, a)
    return current
  })
  pool.activeId = next.activeId
  if (next.removed) pool.removed = next.removed
  else delete pool.removed
}

// Caller MUST own file's mutex. Kept private so refresh does not recursively
// acquire the mutex, or deadlock behind a queued metadata save.
async function persistPoolFile(pool: PoolFile, file: string): Promise<void> {
  const { writeFile, chmod, rename, unlink } = await import("node:fs/promises")
  const base = baselines.get(pool) ?? emptyPool()
  const snapshot = copy(pool)
  const revived = new Map(revivals.get(pool))
  const merged = mergePool(base, snapshot, await readPoolFile(file), revived)
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600, flag: "wx" })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  // Preserve mutations made while disk I/O was pending for the next save.
  adoptPool(pool, mergePool(snapshot, pool, merged, new Map(revivals.get(pool))))
  baselines.set(pool, copy(merged))
  for (const [r, intent] of revived) {
    if (revivals.get(pool)?.get(r) === intent) revivals.get(pool)?.delete(r)
  }
}

export async function savePoolFile(pool: PoolFile): Promise<void> {
  const file = poolFilePath()
  await lockPoolFile(file, () => persistPoolFile(pool, file))
}

/** Cross-process mutex shared by ALL pool writes and refresh. A prepared,
 * nonempty directory is atomically renamed into place. Each owner has a unique
 * filename: concurrent stale-lock reapers can unlink ONLY the dead owner's
 * file, and rmdir cannot remove a successor's nonempty lock. A live local PID
 * is never evicted merely for being slow. Requires a local filesystem with
 * atomic directory rename; mixed old/new plugin writers are not supported. */
async function lockPoolFile<T>(
  file: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const { mkdir, open, rename, unlink, rmdir, stat, readFile, readdir, utimes } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const ownerName = `owner-${process.pid}-${randomUUID()}`
  const candidate = `${lock}.${ownerName}`
  const timeoutMs = opts.timeoutMs ?? 120_000
  const staleMs = opts.staleMs ?? 15_000
  const start = Date.now()
  const dead = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH"
    }
  }
  await mkdir(candidate, { mode: 0o700 })
  const owner = await open(`${candidate}/${ownerName}`, "wx", 0o600).catch(async (e) => {
    await rmdir(candidate).catch(() => {})
    throw e
  })
  let beat: ReturnType<typeof setInterval> | undefined
  let acquired = false
  try {
    await owner.writeFile(`${process.pid}`)
    // Windows: a directory containing an open file handle cannot be renamed
    // (rename fails with EPERM). POSIX allows it, so this only broke on
    // Windows. The handle is no longer needed after the PID write: the
    // heartbeat below touches the owner file by path instead.
    await owner.close().catch(() => {})
    while (true) {
      try {
        await rename(candidate, lock)
        acquired = true
        break
      } catch (e) {
        // Windows also surfaces directory-rename contention (the lock
        // directory already exists, e.g. held by a live peer) as EPERM, so
        // it must be retried like the other contention codes.
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e
        try {
          const st = await stat(lock)
          if (st.isDirectory()) {
            // Snapshot the unique old filename BEFORE checking liveness. A
            // successor has a different filename, so reapers cannot touch it.
            const names = await readdir(lock)
            for (const name of names) {
              if (!/^owner-\d+-[\da-f-]+$/.test(name)) continue
              const path = `${lock}/${name}`
              const ownerStat = await stat(path)
              const pid = Number(await readFile(path, "utf8"))
              if (dead(pid) && Date.now() - ownerStat.mtimeMs > staleMs) await unlink(path).catch(() => {})
            }
            // Empty means a release/reap was interrupted. Nonempty successors
            // cannot be removed (ENOTEMPTY); no check-then-unlink race.
            await rmdir(lock).catch(() => {})
          } else if (Date.now() - st.mtimeMs > staleMs && dead(Number(await readFile(lock, "utf8")))) {
            // Recover a dead old-version lockfile. unlink cannot delete a
            // new-version directory acquired concurrently by another process.
            await unlink(lock).catch(() => {})
          }
        } catch {
          /* lock vanished or changed while inspecting it */
        }
        if (Date.now() - start > timeoutMs) throw new TransientAuthError(`timed out waiting for pool lock (${lock})`)
        await sleep(50 + Math.random() * 100)
      }
    }
    beat = setInterval(
      () => {
        const now = new Date()
        // Touch by path: the handle was closed before the rename (see above).
        void utimes(`${lock}/${ownerName}`, now, now).catch(() => {})
      },
      Math.max(10, Math.floor(staleMs / 3)),
    )
    beat.unref()
    return await fn()
  } finally {
    if (beat) clearInterval(beat)
    await owner.close().catch(() => {})
    if (acquired) {
      await unlink(`${lock}/${ownerName}`).catch(() => {})
      await rmdir(lock).catch(() => {})
    } else {
      await unlink(`${candidate}/${ownerName}`).catch(() => {})
      await rmdir(candidate).catch(() => {})
    }
  }
}

export async function withFileLock<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  return lockPoolFile(poolFilePath(), fn, opts)
}

/** Legacy files mirrored the max model cooldown into limitedUntil. An exact
 * match is interpreted as that old aggregate; other values remain global.
 * An old global cooldown exactly equal to the aggregate is irrecoverably
 * ambiguous. All new writes carry an explicit per-account format marker. */
function migrateLimits(a: PoolAccount): void {
  if (a.limitsVersion === 2) return
  const maxModel = Math.max(0, ...Object.values(a.modelLimits ?? {}))
  if (maxModel && a.limitedUntil === maxModel) delete a.limitedUntil
  a.limitsVersion = 2
}

/** Aggregate for displays, or actual next eligibility for a known model. */
export function cooldownUntil(a: PoolAccount, model?: string): number {
  migrateLimits(a)
  return Math.max(
    a.limitedUntil ?? 0,
    model ? (modelLimitUntil(a, model) ?? 0) : Math.max(0, ...Object.values(a.modelLimits ?? {})),
  )
}

export function pruneLimits(pool: PoolFile, now = Date.now()): boolean {
  let changed = false
  for (const a of trackedAccounts(pool)) {
    migrateLimits(a)
    if (a.limitedUntil && a.limitedUntil <= now) {
      delete a.limitedUntil
      changed = true
    }
    if (a.modelLimits) {
      for (const [m, until] of Object.entries(a.modelLimits)) {
        if (until <= now) {
          delete a.modelLimits[m]
          changed = true
        }
      }
      if (Object.keys(a.modelLimits).length === 0) delete a.modelLimits
    }
    if (!a.limitedUntil && !a.modelLimits && a.lastError?.startsWith("429")) {
      delete a.lastError
      changed = true
    }
  }
  return changed
}

/** Split env lists on commas/whitespace/newlines, drop empties. */
export function splitEnvList(value: string): string[] {
  return value.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length >= 10)
}

export function collectEnvKeys(): string[] {
  const out: string[] = []
  const singles = [process.env.CLINE_API_KEY, process.env.CLINE_FREE_API_KEY]
  for (const s of singles) if (s?.trim()) out.push(s.trim())
  for (const list of [process.env.CLINE_API_KEYS, process.env.CLINE_FREE_API_KEYS]) {
    if (list) out.push(...splitEnvList(list))
  }
  for (let i = 2; i <= 10; i++) {
    for (const v of [process.env[`CLINE_API_KEY_${i}`], process.env[`CLINE_FREE_API_KEY_${i}`]]) {
      if (v?.trim()) out.push(v.trim())
    }
  }
  return [...new Set(out)]
}

export function tokenOf(a: PoolAccount): string | undefined {
  return a.access ?? a.apiKey
}

// Env accounts are never written to the pool file, but they still need
// cooldowns, out-of-credit flags and quarantine like stored accounts. Keep
// one in-memory object per env key so that state survives between requests.
const envAccounts = new WeakMap<PoolFile, Map<string, PoolAccount>>()

function envAccount(pool: PoolFile, id: string, key: string, label: string): PoolAccount {
  let byId = envAccounts.get(pool)
  if (!byId) {
    byId = new Map()
    envAccounts.set(pool, byId)
  }
  const existing = byId.get(id)
  if (existing) {
    existing.label = label
    return existing
  }
  const acc: PoolAccount = { id, label, apiKey: key, source: "env", addedAt: 0 }
  byId.set(id, acc)
  return acc
}

/** Stored accounts plus the env accounts seen so far (in-memory state). */
export function trackedAccounts(pool: PoolFile): PoolAccount[] {
  return [...pool.accounts, ...(envAccounts.get(pool)?.values() ?? [])]
}

/** A stored or env account by id. */
export function findAccount(pool: PoolFile, id: string | undefined): PoolAccount | undefined {
  if (!id) return undefined
  return pool.accounts.find((a) => a.id === id) ?? envAccounts.get(pool)?.get(id)
}

/** Pool accounts plus ephemeral env accounts, deduped by user then token.
 * Same Cline user with two sessions shares one daily quota, so only the
 * freshest entry per user is a rotation candidate. */
export function allCandidates(pool: PoolFile): PoolAccount[] {
  const sorted = [...pool.accounts].sort((a, b) => freshnessOf(b) - freshnessOf(a))
  const seenToken = new Set<string>()
  const seenUser = new Set<string>()
  const out: PoolAccount[] = []
  for (const a of sorted) {
    const t = tokenOf(a)
    if (!t) continue
    // Quarantined accounts (terminal auth failure) stay out of rotation
    // until re-login or a successful validation probe.
    if (a.authFailedAt) continue
    const tkey = stripWorkOSPrefix(t)
    if (seenToken.has(tkey)) continue
    const ukey = clineUserKey(t) ?? (accountEmail(a) ? `email:${accountEmail(a)}` : undefined)
    if (ukey) {
      if (seenUser.has(ukey)) continue
      seenUser.add(ukey)
    }
    seenToken.add(tkey)
    out.push(a)
  }
  const envKeys = collectEnvKeys()
  envKeys.forEach((key, i) => {
    const k = stripWorkOSPrefix(key)
    if (seenToken.has(k)) return
    const ukey = clineUserKey(key) ?? (normalizeEmailLabel(key) ? `email:${normalizeEmailLabel(key)}` : undefined)
    if (ukey && seenUser.has(ukey)) return
    if (ukey) seenUser.add(ukey)
    seenToken.add(k)
    const fp = createHash("sha256").update(k).digest("hex")
    const acc = envAccount(
      pool,
      `env-${fp}`,
      key.trim(),
      envKeys.length > 1 ? `env-${i + 1} (${maskToken(key)})` : `env (${maskToken(key)})`,
    )
    if (acc.authFailedAt) return
    out.push(acc)
  })
  return out
}

/** Collapse stored duplicates (same Cline user, different session tokens).
 * Keeps the freshest entry per user/email, drops the rest. Returns true
 * when anything was removed. Also repairs activeId. */
export function dedupePool(pool: PoolFile): boolean {
  // API-key accounts (sk_…) carry no JWT identity and are often the fallback
  // credential for the same Cline user as an OAuth account, so they must
  // never be collapsed by email match.
  const keepAlways = new Set(
    pool.accounts.filter((a) => a.apiKey && !a.access).map((a) => a.id),
  )
  const bestByUser = new Map<string, PoolAccount>()
  const bestByEmail = new Map<string, PoolAccount>()
  for (const a of pool.accounts) {
    if (keepAlways.has(a.id)) continue
    const t = tokenOf(a)
    if (!t) continue
    const ukey = clineUserKey(t)
    if (ukey) {
      const cur = bestByUser.get(ukey)
      if (!cur || freshnessOf(a) > freshnessOf(cur)) bestByUser.set(ukey, a)
      continue
    }
    const email = accountEmail(a)
    if (email) {
      const cur = bestByEmail.get(email)
      if (!cur || freshnessOf(a) > freshnessOf(cur)) bestByEmail.set(email, a)
    }
  }
  if (bestByUser.size === 0 && bestByEmail.size === 0 && keepAlways.size === 0) return false
  const keep = new Set<string>(keepAlways)
  for (const a of bestByUser.values()) keep.add(a.id)
  for (const a of bestByEmail.values()) {
    // Don't let a generic email fallback rescue an entry that already lost
    // its user group — only keep it if no user-keyed entry claims that email.
    const claimed = [...bestByUser.values()].some((u) => accountEmail(u) === a.label?.trim().toLowerCase() || accountEmail(u) === accountEmail(a))
    if (!claimed) keep.add(a.id)
  }
  // Entries with no decodable identity are always kept (can't prove dup).
  for (const a of pool.accounts) {
    const t = tokenOf(a)
    if (!t) {
      keep.add(a.id)
      continue
    }
    if (!clineUserKey(t) && !accountEmail(a)) keep.add(a.id)
  }
  if (keep.size === pool.accounts.length) return false
  const kept = pool.accounts.filter((a) => keep.has(a.id))
  const removed = pool.accounts.filter((a) => !keep.has(a.id))
  pool.accounts = kept
  if (pool.activeId && !keep.has(pool.activeId)) {
    // Point active at the surviving sibling of the removed active account.
    const oldActive = removed.find((a) => a.id === pool.activeId)
    const oldToken = oldActive ? tokenOf(oldActive) : undefined
    const siblingKey = oldToken ? clineUserKey(oldToken) : undefined
    const sibling = siblingKey ? bestByUser.get(siblingKey) : undefined
    pool.activeId = sibling?.id ?? kept[0]?.id
    if (!pool.activeId) delete pool.activeId
  }
  pool.activeId ??= kept[0]?.id
  return true
}

export function findOAuthDuplicate(
  pool: PoolFile,
  access: string,
  label?: string,
): PoolAccount | undefined {
  const key = stripWorkOSPrefix(access)
  const byToken = pool.accounts.find((a) => {
    const t = tokenOf(a)
    return !!t && stripWorkOSPrefix(t) === key
  })
  if (byToken) return byToken
  // API keys (sk_…) have no JWT identity: they must stay a separate fallback
  // account, never merged into (or matched by email with) an OAuth account.
  if (!decodeJwtPayload(key)) return undefined
  const ukey = clineUserKey(access)
  if (ukey) {
    const byUser = pool.accounts.find((a) => {
      const t = tokenOf(a)
      return !!t && clineUserKey(t) === ukey
    })
    if (byUser) return byUser
  }
  const email = normalizeEmailLabel(label) ?? payloadEmail(access)
  if (email) {
    const byEmail = pool.accounts.find((a) => accountEmail(a) === email)
    if (byEmail) return byEmail
  }
  return undefined
}

export function findByToken(pool: PoolFile, token: string): PoolAccount | undefined {
  const key = stripWorkOSPrefix(token)
  return (
    pool.accounts.find((a) => {
      const t = tokenOf(a)
      return !!t && stripWorkOSPrefix(t) === key
    }) ?? allCandidates(pool).find((a) => {
      const t = tokenOf(a)
      return !!t && stripWorkOSPrefix(t) === key
    })
  )
}

export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${withWorkOSPrefix(accessToken)}`, Accept: "application/json" },
    })
    if (!res.ok) return undefined
    const j = (await res.json().catch(() => undefined)) as any
    const email =
      j?.data?.email ?? j?.data?.user?.email ?? j?.email ?? j?.user?.email ?? j?.data?.userInfo?.email
    return typeof email === "string" && email.includes("@") ? email : undefined
  } catch {
    return undefined
  }
}

export type Logger = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Clear all health state: cooldowns, errors, and auth quarantine.
 * Explicit logins reset everything; token refreshes preserve per-model
 * quotas because those belong to the Cline user, not the access token. */
export function clearAuthHealth(acc: PoolAccount, options: { preserveModelLimits?: boolean } = {}): void {
  acc.limitsVersion = 2
  if (!options.preserveModelLimits) delete acc.modelLimits
  delete acc.limitedUntil
  delete acc.lastError
  delete acc.authFailedAt
  delete acc.authFailedReason
  delete acc.lastProbeAt
}

export function upsertOAuthAccount(
  pool: PoolFile,
  creds: { access: string; refresh: string; expires: number },
  label?: string,
  source: AccountSource = "oauth",
): PoolAccount {
  const acc = findOAuthDuplicate(pool, creds.access, label)
  if (acc) {
    acc.access = stripWorkOSPrefix(creds.access)
    acc.refresh = creds.refresh
    acc.expires = creds.expires
    // Prefer a real email label over generic ones (cline-1, connect-token…).
    const emailLabel = normalizeEmailLabel(label)
    if (emailLabel) acc.label = emailLabel
    else if (isGenericLabel(acc.label)) {
      const fromToken = payloadEmail(creds.access)
      if (fromToken) acc.label = fromToken
      else if (label?.trim()) acc.label = label.trim()
    }
    clearAuthHealth(acc)
    dedupePool(pool)
    pool.activeId ??= acc.id
    return acc
  }
  const emailFromToken = payloadEmail(creds.access)
  const fresh: PoolAccount = {
    id: newAccountId(),
    label: normalizeEmailLabel(label) ?? emailFromToken ?? label?.trim() ?? `cline-${pool.accounts.length + 1}`,
    access: stripWorkOSPrefix(creds.access),
    refresh: creds.refresh,
    expires: creds.expires,
    source,
    addedAt: Date.now(),
  }
  pool.accounts.push(fresh)
  dedupePool(pool)
  pool.activeId ??= fresh.id
  return pool.accounts.find((a) => a.id === fresh.id) ?? fresh
}

export function upsertApiAccount(pool: PoolFile, key: string, label?: string, source: AccountSource = "api"): PoolAccount {
  const acc = findOAuthDuplicate(pool, key, label)
  if (acc) {
    if (acc.access) acc.access = stripWorkOSPrefix(key.trim())
    else acc.apiKey = key.trim()
    const emailLabel = normalizeEmailLabel(label)
    if (emailLabel) acc.label = emailLabel
    else if (isGenericLabel(acc.label) && label?.trim()) acc.label = label.trim()
    clearAuthHealth(acc)
    dedupePool(pool)
    pool.activeId ??= acc.id
    return acc
  }
  const fresh: PoolAccount = {
    id: newAccountId(),
    label: normalizeEmailLabel(label) ?? label?.trim() ?? `token-${maskToken(stripWorkOSPrefix(key.trim()))}`,
    apiKey: key.trim(),
    source,
    addedAt: Date.now(),
  }
  pool.accounts.push(fresh)
  dedupePool(pool)
  pool.activeId ??= fresh.id
  return pool.accounts.find((a) => a.id === fresh.id) ?? fresh
}

// --- Removed accounts ---

const MAX_REMOVED = 200

/** Stable, non-reversible identity for a token: the Cline user when the
 * token is a JWT, else the token itself. Hashed so the pool file never keeps
 * a removed token around. */
export function identityHash(token: string): string {
  const id = clineUserKey(token) ?? `tok:${stripWorkOSPrefix(token)}`
  return createHash("sha256").update(id).digest("hex").slice(0, 32)
}

export function isRemoved(pool: PoolFile, token: string): boolean {
  return !!pool.removed?.includes(identityHash(token))
}

export function rememberRemoval(pool: PoolFile, token: string): void {
  const id = identityHash(token)
  const list = (pool.removed ?? []).filter((r) => r !== id)
  list.push(id)
  pool.removed = list.slice(-MAX_REMOVED)
}

/** An explicit login (device, CLI import, add-token) brings the user back. */
export function forgetRemoval(pool: PoolFile, token: string): void {
  const id = identityHash(token)
  const revived = revivals.get(pool) ?? new Map<string, symbol>()
  revived.set(id, Symbol())
  revivals.set(pool, revived)
  if (!pool.removed) return
  pool.removed = pool.removed.filter((r) => r !== id)
  if (pool.removed.length === 0) delete pool.removed
}

// In-flight refreshes keyed by account id (single-flight): concurrent
// requests share ONE refresh instead of each firing its own. Without this,
// rotation + reuse detection on the server side sees a replayed refresh
// token and can revoke the session (invalid_grant lockout caused by us).
const refreshFlights = new WeakMap<PoolFile, Map<string, Promise<void>>>()

/** Ensure acc has fresh tokens. Joins an in-flight refresh when one exists,
 * adopts a peer process's newer tokens under the file lock when available,
 * and otherwise refreshes (with retry) and persists atomically.
 * Throws TerminalAuthError (re-login required) or TransientAuthError. */
export async function refreshAccount(pool: PoolFile, acc: PoolAccount, log: Logger): Promise<void> {
  const file = poolFilePath()
  const flightKey = `${file}\0${acc.id}`
  const refreshFlight = refreshFlights.get(pool) ?? new Map<string, Promise<void>>()
  refreshFlights.set(pool, refreshFlight)
  const inflight = refreshFlight.get(flightKey)
  if (inflight) {
    await inflight
    return
  }
  const p = (async (): Promise<void> => {
    await lockPoolFile(file, async () => {
      // A peer process may have refreshed while we waited for the lock:
      // adopt its tokens instead of replaying our (now stale) refresh token.
      const disk = await readPoolFile(file)
      const peer = disk.accounts.find((a) => a.id === acc.id)
      if (
        (!peer && baselines.get(pool)?.accounts.some((a) => a.id === acc.id)) ||
        (tokenOf(acc) && isRemoved(disk, tokenOf(acc)!))
      ) {
        adoptPool(pool, disk)
        baselines.set(pool, copy(disk))
        throw new TerminalAuthError("account removed by another process — re-login required")
      }
      const observed = baselines.get(pool)?.accounts.find((a) => a.id === acc.id)
      const peerChanged = !!peer && (!observed || !equal(credentials(peer), credentials(observed)))
      const peerTok = peer ? tokenOf(peer) : undefined
      const mine = tokenOf(acc)
      if (
        peerChanged &&
        peer?.refresh &&
        peer?.expires &&
        peer.expires - Date.now() >= REFRESH_BUFFER_MS &&
        peerTok &&
        mine &&
        (stripWorkOSPrefix(peerTok) !== stripWorkOSPrefix(mine) || peer.refresh !== acc.refresh)
      ) {
        acc.access = peer.access
        acc.apiKey = peer.apiKey
        acc.refresh = peer.refresh
        acc.expires = peer.expires
        // Quotas belong to the user. Keep local reports and any model limits
        // learned by the peer after our snapshot; adopting only its token
        // would otherwise make those capped models immediately selectable.
        const modelLimits = { ...acc.modelLimits }
        for (const [model, until] of Object.entries(peer.modelLimits ?? {})) {
          modelLimits[model] = Math.max(modelLimits[model] ?? 0, until)
        }
        if (Object.keys(modelLimits).length) acc.modelLimits = modelLimits
        clearAuthHealth(acc, { preserveModelLimits: true })
        rebaseCredentials(pool, peer)
        log("info", `cline-free: adopted peer-refreshed tokens for ${acc.label ?? acc.id}`)
        return
      }
      // Even if the peer token has already expired, its rotated refresh
      // credential is the only one safe to use. Select only after locking and
      // reconciliation: a queued save may have adopted it and rebased the pool.
      const refreshToken = peerChanged ? (peer?.refresh ?? acc.refresh) : acc.refresh
      if (!refreshToken) {
        throw new TerminalAuthError(
          `account ${acc.label ?? acc.id} has no refresh token — re-login required (/connect → cline-free)`,
        )
      }
      const next = await refreshClineToken(refreshToken, {
        label: acc.label ?? acc.id,
        log,
      })
      acc.access = next.access
      acc.refresh = next.refresh
      acc.expires = next.expires
      clearAuthHealth(acc, { preserveModelLimits: true })
      // Rebase the credential group to the locked disk record.
      if (peer) rebaseCredentials(pool, peer)
      await persistPoolFile(pool, file)
    })
  })()
  refreshFlight.set(flightKey, p)
  try {
    await p
  } finally {
    refreshFlight.delete(flightKey)
  }
}

/** Park an account after a terminal auth failure. It leaves rotation
 * immediately; re-login (upsert) or a successful validation probe clears it. */
export function quarantineAccount(pool: PoolFile, acc: PoolAccount, reason: string, log: Logger): void {
  acc.authFailedAt = Date.now()
  acc.authFailedReason = reason
  delete acc.limitedUntil
  void savePoolFile(pool).catch(() => {})
  log(
    "error",
    `cline-free: account ${acc.label ?? acc.id} needs re-login (${reason}). Run /connect → cline-free and log in again; rotation continues on the remaining accounts.`,
    { accountId: acc.id },
  )
}

export const PROBE_INTERVAL_MS = 15 * 60 * 1000

/** Self-healing for quarantines (covers misclassification): at most every
 * 15 min per account, re-validate a quarantined account whose stored access
 * token still looks usable. A pass returns it to rotation. */
export async function probeQuarantinedAccounts(pool: PoolFile, log: Logger): Promise<void> {
  const now = Date.now()
  let changed = false
  for (const acc of trackedAccounts(pool)) {
    if (!acc.authFailedAt) continue
    if (acc.lastProbeAt && now - acc.lastProbeAt < PROBE_INTERVAL_MS) continue
    acc.lastProbeAt = now
    changed = true
    const t = tokenOf(acc)
    if (t && (!acc.expires || acc.expires - now > 0)) {
      try {
        if (await validateClineToken(t)) {
          delete acc.authFailedAt
          delete acc.authFailedReason
          delete acc.lastProbeAt
          log("info", `cline-free: account ${acc.label ?? acc.id} recovered on probe — back in rotation`, {
            accountId: acc.id,
          })
        }
      } catch {
        /* probe failure keeps the quarantine */
      }
    }
  }
  if (changed) void savePoolFile(pool).catch(() => {})
}

// In-memory rotation cursor (round-robin across healthy accounts).
// Round-robin cursor per model, indexed over HEALTHY accounts only, so
// cooldowns on some accounts never skew the spread across the rest.
const rrCursors = new Map<string, number>()

// Accounts that answered HTTP 402 `insufficient_credits`. Cline's starter
// credits never refill, so paid models skip these accounts until OpenCode
// restarts (memory only, never saved). Free models keep using them.
const noCredits = new WeakMap<PoolFile, Set<string>>()

export function hasNoCredits(pool: PoolFile, id: string) {
  return noCredits.get(pool)?.has(id) ?? false
}

export function markNoCredits(pool: PoolFile, id: string, log: Logger, detail?: string) {
  const ids = noCredits.get(pool) ?? new Set<string>()
  ids.add(id)
  noCredits.set(pool, ids)
  const acc = findAccount(pool, id)
  log(
    "warn",
    `cline-free: account ${acc?.label ?? id} is out of Cline credits — skipping it for paid models until OpenCode restarts${detail ? ` (${detail})` : ""}`,
    { accountId: id },
  )
}

/** True when `a` can serve `model` right now: not out of credits (paid
 * models), and neither its cooldown for the model nor its account-wide
 * cooldown is running. */
export function isAvailable(pool: PoolFile, a: PoolAccount, now: number, model: string | undefined): boolean {
  if (isPaidModel(model) && hasNoCredits(pool, a.id)) return false
  const until = modelLimitUntil(a, model)
  if (until && until > now) return false
  migrateLimits(a)
  return !a.limitedUntil || a.limitedUntil <= now
}

/** Next healthy account in round-robin order; undefined when all limited.
 * An account is healthy only when its account-wide cooldown AND its cooldown
 * for the requested model (if any) have both expired. */
export function selectAccount(pool: PoolFile, now = Date.now(), model?: string): PoolAccount | undefined {
  const candidates = allCandidates(pool)
  // Start scanning at the cursor, keyed on the full candidate order so
  // parallel requests spread across accounts.
  const healthy = candidates.filter((a) => isAvailable(pool, a, now, model))
  if (healthy.length === 0) return undefined
  const key = model ?? ""
  const cursor = rrCursors.get(key) ?? 0
  const pick = healthy[cursor % healthy.length] ?? healthy[0]
  rrCursors.set(key, (cursor + 1) % healthy.length)
  return pick
}

// --- Session pinning ---
//
// Prompt caches are warm only on the account that served the previous turn,
// so a session sticks to one account per model and only moves when that
// account is rate limited, out of credits or needs re-login. Without this the
// round-robin cursor moved every turn of a session to a different account.
const sessionPins = new WeakMap<PoolFile, Map<string, string>>()
const MAX_PINS = 1000
const pinKey = (sessionID: string, model: string | undefined) => `${sessionID}\u0000${model ?? ""}`

export function pinnedAccountId(pool: PoolFile, sessionID: string, model: string | undefined): string | undefined {
  return sessionPins.get(pool)?.get(pinKey(sessionID, model))
}

export function pinSession(pool: PoolFile, sessionID: string, model: string | undefined, accountId: string): void {
  let pins = sessionPins.get(pool)
  if (!pins) {
    pins = new Map()
    sessionPins.set(pool, pins)
  }
  const key = pinKey(sessionID, model)
  pins.delete(key)
  pins.set(key, accountId)
  // Map keeps insertion order: drop the least recently pinned sessions.
  while (pins.size > MAX_PINS) pins.delete(pins.keys().next().value!)
}

/** The session's pinned account while it can still serve `model`; otherwise
 * the next healthy account in round-robin order, which becomes the new pin. */
export function selectAccountForSession(
  pool: PoolFile,
  now: number,
  model: string | undefined,
  sessionID: string | undefined,
): PoolAccount | undefined {
  if (!sessionID) return selectAccount(pool, now, model)
  const pinned = pinnedAccountId(pool, sessionID, model)
  if (pinned) {
    const acc = allCandidates(pool).find((a) => a.id === pinned)
    if (acc && isAvailable(pool, acc, now, model)) return acc
  }
  const next = selectAccount(pool, now, model)
  if (next) pinSession(pool, sessionID, model, next.id)
  return next
}

export function markAccountLimited(
  pool: PoolFile,
  id: string,
  retryAfterMs: number | undefined,
  log: Logger,
  detail?: string,
  model?: string,
): void {
  const acc = findAccount(pool, id)
  const until = Date.now() + (retryAfterMs ?? nextUtcMidnightMs() - Date.now())
  const name = acc?.label ?? id
  if (acc) {
    migrateLimits(acc)
    if (model) {
      acc.modelLimits ??= {}
      acc.modelLimits[model] = until
    } else {
      acc.limitedUntil = Math.max(acc.limitedUntil ?? 0, until)
    }
    acc.lastError = `429${detail ? `: ${detail}` : ""}`
  }
  log(
    "warn",
    `cline-free: account ${name} hit 429${model ? ` on ${model}` : ""} — cooling down until ${new Date(until).toISOString()}${detail ? ` (${detail})` : ""}`,
    { accountId: id, limitedUntil: until },
  )
  void savePoolFile(pool).catch(() => {})
}

export function describeLimits(pool: PoolFile): string {
  const limited = pool.accounts.filter((a) => cooldownUntil(a) > Date.now())
  if (limited.length === 0) return ""
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}→${new Date(cooldownUntil(a)).toISOString()}`).join(", ")}.`
}
