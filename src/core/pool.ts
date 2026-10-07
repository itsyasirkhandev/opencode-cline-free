import { refreshClineToken, validateClineToken } from "./auth.ts"
import { ACCOUNTS_FILE_NAME, API_BASE, REFRESH_BUFFER_MS } from "./constants.ts"
import { TerminalAuthError, TransientAuthError, fetchWithTimeout, sleep, withWorkOSPrefix } from "./http.ts"

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
  /** ms epoch until which this account is skipped (set on 429). */
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

export type PoolFile = { version: 1; activeId?: string; accounts: PoolAccount[] }

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
  return (
    url.startsWith(API_BASE) &&
    (url.includes("/chat/completions") || url.includes("/completions"))
  )
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

export async function loadPoolFile(): Promise<PoolFile> {
  try {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(poolFilePath(), "utf8")
    const data = JSON.parse(raw) as Partial<PoolFile>
    const accounts = Array.isArray(data.accounts)
      ? data.accounts.filter(
          (a): a is PoolAccount =>
            !!a && typeof a.id === "string" && (typeof a.access === "string" || typeof a.apiKey === "string"),
        )
      : []
    return { version: 1, activeId: typeof data.activeId === "string" ? data.activeId : undefined, accounts }
  } catch {
    return { version: 1, accounts: [] }
  }
}

export async function savePoolFile(pool: PoolFile): Promise<void> {
  // Atomic write (tmp + rename): a crash mid-write can never leave a
  // half-written pool file behind. Per-save metadata races across processes
  // (lastUsed etc.) resolve last-writer-wins, which is acceptable; token
  // updates converge via peer-adoption inside refreshAccount's file lock.
  const { mkdir, writeFile, chmod, rename, unlink } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const file = poolFilePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    await writeFile(tmp, JSON.stringify(pool, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/** Cross-process mutex around refresh critical sections (lockfile with
 * stale-lock breaking). Prevents two opencode instances from refreshing
 * the same account concurrently and tripping reuse detection. */
export async function withFileLock<T>(fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const { open, unlink, stat, utimes } = await import("node:fs/promises")
  const lock = `${poolFilePath()}.lock`
  const timeoutMs = opts.timeoutMs ?? 5000
  const staleMs = opts.staleMs ?? 15000
  const start = Date.now()
  while (true) {
    try {
      const fh = await open(lock, "wx", 0o600)
      await fh.writeFile(`${process.pid}`).catch(() => {})
      await fh.close().catch(() => {})
      break
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== "EEXIST") throw e
      try {
        const st = await stat(lock)
        if (Date.now() - st.mtimeMs > staleMs) {
          await unlink(lock).catch(() => {})
          continue
        }
      } catch {
        continue // lock vanished between open and stat; retry
      }
      if (Date.now() - start > timeoutMs) {
        throw new TransientAuthError(`timed out waiting for pool lock (${lock})`)
      }
      await sleep(50 + Math.random() * 100)
    }
  }
  // Heartbeat: keep the lock's mtime fresh while fn runs, so a slow token
  // refresh (up to ~4 x 15s with retries) is never mistaken for a stale lock
  // and broken by another OpenCode process.
  const beat = setInterval(() => {
    const now = new Date()
    void utimes(lock, now, now).catch(() => {})
  }, Math.max(250, Math.floor(staleMs / 3)))
  ;(beat as { unref?: () => void }).unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(beat)
    await unlink(lock).catch(() => {})
  }
}

export function pruneLimits(pool: PoolFile, now = Date.now()): boolean {
  let changed = false
  for (const a of pool.accounts) {
    if (a.limitedUntil && a.limitedUntil <= now) {
      delete a.limitedUntil
      delete a.lastError
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
    const fp = `${k.slice(0, 4)}${k.slice(-4)}${k.length}`
    out.push({
      id: `env-${fp}`,
      label: envKeys.length > 1 ? `env-${i + 1} (${maskToken(key)})` : `env (${maskToken(key)})`,
      apiKey: key.trim(),
      source: "env",
      addedAt: 0,
    })
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
 * Called whenever fresh credentials land for an account. */
export function clearAuthHealth(acc: PoolAccount): void {
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

// In-flight refreshes keyed by account id (single-flight): concurrent
// requests share ONE refresh instead of each firing its own. Without this,
// rotation + reuse detection on the server side sees a replayed refresh
// token and can revoke the session (invalid_grant lockout caused by us).
const refreshFlight = new Map<string, Promise<void>>()

/** Ensure acc has fresh tokens. Joins an in-flight refresh when one exists,
 * adopts a peer process's newer tokens under the file lock when available,
 * and otherwise refreshes (with retry) and persists atomically.
 * Throws TerminalAuthError (re-login required) or TransientAuthError. */
export async function refreshAccount(pool: PoolFile, acc: PoolAccount, log: Logger): Promise<void> {
  const inflight = refreshFlight.get(acc.id)
  if (inflight) {
    await inflight
    return
  }
  const p = (async (): Promise<void> => {
    const refreshToken = acc.refresh
    if (!refreshToken) {
      throw new TerminalAuthError(`account ${acc.label ?? acc.id} has no refresh token — re-login required (/connect → cline-free)`)
    }
    await withFileLock(async () => {
      // A peer process may have refreshed while we waited for the lock:
      // adopt its tokens instead of replaying our (now stale) refresh token.
      const disk = await loadPoolFile()
      const peer = disk.accounts.find((a) => a.id === acc.id)
      const peerTok = peer ? tokenOf(peer) : undefined
      const mine = tokenOf(acc)
      if (
        peer?.refresh && peer?.expires && peer.expires - Date.now() >= REFRESH_BUFFER_MS &&
        peerTok && mine && stripWorkOSPrefix(peerTok) !== stripWorkOSPrefix(mine)
      ) {
        acc.access = peer.access
        acc.apiKey = peer.apiKey
        acc.refresh = peer.refresh
        acc.expires = peer.expires
        clearAuthHealth(acc)
        log("info", `cline-free: adopted peer-refreshed tokens for ${acc.label ?? acc.id}`)
        return
      }
      const next = await refreshClineToken(refreshToken, { label: acc.label ?? acc.id, log })
      acc.access = next.access
      acc.refresh = next.refresh
      acc.expires = next.expires
      clearAuthHealth(acc)
      await savePoolFile(pool)
    })
  })()
  refreshFlight.set(acc.id, p)
  try {
    await p
  } finally {
    refreshFlight.delete(acc.id)
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
  for (const acc of pool.accounts) {
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

/** Next healthy account in round-robin order; undefined when all limited.
 * An account is healthy only when its account-wide cooldown AND its cooldown
 * for the requested model (if any) have both expired. */
export function selectAccount(pool: PoolFile, now = Date.now(), model?: string): PoolAccount | undefined {
  const candidates = allCandidates(pool)
  // Start scanning at the cursor, keyed on the full candidate order so
  // parallel requests spread across accounts.
  const healthy = candidates.filter((a) => {
    if (a.limitedUntil && a.limitedUntil > now) return false
    const until = modelLimitUntil(a, model)
    return !until || until <= now
  })
  if (healthy.length === 0) return undefined
  const key = model ?? ""
  const cursor = rrCursors.get(key) ?? 0
  const pick = healthy[cursor % healthy.length] ?? healthy[0]
  rrCursors.set(key, (cursor + 1) % healthy.length)
  return pick
}

export function markAccountLimited(
  pool: PoolFile,
  id: string,
  retryAfterMs: number | undefined,
  log: Logger,
  detail?: string,
  model?: string,
): void {
  const acc = pool.accounts.find((a) => a.id === id)
  const until = Date.now() + (retryAfterMs ?? nextUtcMidnightMs() - Date.now())
  const name = acc?.label ?? id
  if (acc) {
    if (model) {
      acc.modelLimits ??= {}
      acc.modelLimits[model] = until
      // Keep limitedUntil as the account's max cooldown across models so
      // existing status displays and the earliest-reset replay stay honest.
      if (!acc.limitedUntil || acc.limitedUntil < until) acc.limitedUntil = until
    } else {
      acc.limitedUntil = until
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
  const limited = pool.accounts.filter((a) => a.limitedUntil && a.limitedUntil > Date.now())
  if (limited.length === 0) return ""
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}→${new Date(a.limitedUntil!).toISOString()}`).join(", ")}.`
}
