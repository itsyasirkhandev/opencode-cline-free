// Runtime-agnostic account selection: native-auth merge, pick, refresh and
// fallback. Both the V1 auth loader and the (future) V2 request hook call
// into this, so rotation behaves identically on every OpenCode version.
import { TerminalAuthError } from "./http.ts"
import {
  type Logger,
  type PoolAccount,
  type PoolFile,
  allCandidates,
  dedupePool,
  describeLimits,
  fetchUserEmail,
  isGenericLabel,
  normalizeEmailLabel,
  payloadEmail,
  probeQuarantinedAccounts,
  pruneLimits,
  quarantineAccount,
  refreshAccount,
  savePoolFile,
  selectAccount,
  tokenOf,
  upsertApiAccount,
  upsertOAuthAccount,
} from "./pool.ts"
import { REFRESH_BUFFER_MS } from "./constants.ts"

/** A host-stored credential (V1 `Auth`), loosely typed on purpose. */
export type NativeAuth =
  | { type: "api"; key?: unknown }
  | { type: "oauth"; access?: unknown; refresh?: unknown; expires?: unknown; accountId?: unknown }
  | { type?: string; [key: string]: unknown }
  | undefined

/** Merge the host's single stored credential into the pool (update in place
 * when the same Cline user logs in again, append only for new users) so
 * repeated logins accumulate UNIQUE accounts. */
export function mergeNativeAuth(pool: PoolFile, auth: NativeAuth): void {
  const a = auth as Record<string, unknown> | undefined
  if (a?.type === "api" && typeof a.key === "string" && a.key.trim()) {
    const snapshot = JSON.stringify(pool.accounts)
    upsertApiAccount(pool, String(a.key), undefined)
    if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {})
  } else if (a?.type === "oauth" && typeof a.access === "string") {
    const snapshot = JSON.stringify(pool.accounts)
    const acc = upsertOAuthAccount(
      pool,
      { access: String(a.access), refresh: String(a.refresh ?? ""), expires: Number(a.expires ?? 0) },
      typeof a.accountId === "string" ? a.accountId : undefined,
    )
    // Backfill a friendly label once per new account.
    if ((!acc.label || acc.label === a.accountId) && isGenericLabel(acc.label)) {
      const knownEmail =
        normalizeEmailLabel(typeof a.accountId === "string" ? a.accountId : undefined) ?? payloadEmail(String(a.access))
      if (knownEmail) {
        acc.label = knownEmail
        void savePoolFile(pool).catch(() => {})
      } else {
        void fetchUserEmail(String(a.access)).then((email) => {
          if (email) {
            acc.label = email
            void savePoolFile(pool).catch(() => {})
          }
        })
      }
    }
    if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {})
  }
}

export type ResolveOptions = {
  /** Called after an account's token was refreshed successfully (V1 uses it
   * to keep the host's stored credential in sync). */
  onRefreshed?: (account: PoolAccount) => Promise<void>
}

/** Pick the account to use for the next request and return its raw token
 * (no workos: prefix), or undefined when no account is usable. Mutates the
 * pool (activeId, lastUsed, refreshes, quarantine) exactly like the original
 * V1 loader did. */
export async function resolveActiveToken(pool: PoolFile, log: Logger, opts: ResolveOptions = {}): Promise<string | undefined> {
  let picked = selectAccount(pool, Date.now())
  if (!picked && pool.accounts.some((a) => a.authFailedAt)) {
    // No healthy account, but quarantined ones exist: give the recovery
    // probes a chance before reporting exhaustion (lazy, so the hot path
    // never pays probe latency).
    await probeQuarantinedAccounts(pool, log)
    picked = selectAccount(pool, Date.now())
  }
  if (!picked) {
    const candidates = allCandidates(pool)
    if (candidates.length === 0) return undefined
    // Every account is cooling down: hand the request to the fetch router
    // with the earliest-reset account — it selects per model (accounts
    // limited on THIS model still block, others qualify), so a 429 on glm
    // doesn't block muse.
    const earliest = [...candidates].sort((a, b) => (b.limitedUntil ?? 0) - (a.limitedUntil ?? 0))[0]
    const t = tokenOf(earliest)
    if (!t) return undefined
    log("warn", `cline-free: all accounts cooling down — next reset ${new Date(earliest.limitedUntil ?? Date.now()).toISOString()}${describeLimits(pool)}`)
    return t
  }

  // Refresh the picked oauth account if it is about to expire.
  // Single-flight + persisted: concurrent requests share one refresh, so
  // rotation on the server never sees a replayed refresh token.
  const useFallback = (exceptId: string): string | undefined => {
    const fb = selectAccount(pool, Date.now())
    const ft = fb ? tokenOf(fb) : undefined
    if (fb && ft && fb.id !== exceptId) {
      pool.activeId = fb.id
      fb.lastUsed = Date.now()
      void savePoolFile(pool).catch(() => {})
      return ft
    }
    return undefined
  }
  const needsRefresh =
    !!picked.access && typeof picked.expires === "number" && picked.expires - Date.now() < REFRESH_BUFFER_MS
  if (needsRefresh && !picked.refresh) {
    // Expired access token with no refresh token: unusable until re-login.
    quarantineAccount(pool, picked, "access token expired and no refresh token is stored", log)
    const fb = useFallback(picked.id)
    if (fb) return fb
    // No usable fallback: continue with the quarantined token below so the
    // caller sees the real server response instead of nothing.
  } else if (needsRefresh) {
    try {
      await refreshAccount(pool, picked, log)
      await opts.onRefreshed?.(picked)
    } catch (e) {
      if (e instanceof TerminalAuthError) {
        // Dead credential (invalid_grant et al.): park it so it stops
        // failing every Nth request; user re-logins via /connect.
        quarantineAccount(pool, picked, e.message, log)
      } else {
        log("warn", `cline-free: token refresh failed for ${picked.label ?? picked.id}: ${e instanceof Error ? e.message : String(e)} — trying next account`, { accountId: picked.id })
        picked.lastError = "refresh failed"
        void savePoolFile(pool).catch(() => {})
      }
      const fb = useFallback(picked.id)
      if (fb) return fb
    }
  }

  const token = tokenOf(picked)
  if (!token) return undefined
  pool.activeId = picked.id
  picked.lastUsed = Date.now()
  return token
}

/** Housekeeping run before each selection. */
export function tidyPool(pool: PoolFile): void {
  if (pruneLimits(pool) || dedupePool(pool)) void savePoolFile(pool).catch(() => {})
}
