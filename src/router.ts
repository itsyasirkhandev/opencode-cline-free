import { REFRESH_BUFFER_MS } from "./constants.ts"
import { TerminalAuthError, withWorkOSPrefix } from "./http.ts"
import { isPaidModel } from "./models.ts"
import { type Logger, type PoolFile, allCandidates, clineUserKey, findByToken, isAuthFailure, isRoutableUrl, markAccountLimited, maskToken, modelLimitUntil, modelOfRequest, parseRetryAfterFromBody, parseRetryAfterMs, pruneLimits, quarantineAccount, refreshAccount, sameAccount, savePoolFile, selectAccount, stripWorkOSPrefix, tokenOf } from "./pool.ts"

// --- Transparent same-request 429 + 401 failover ---
//
// OpenCode's AI SDK performs the HTTPS call with the apiKey the loader
// returned. When Cline answers 429 we swap in the next healthy account and
// replay the request, so one exhausted daily quota doesn't fail the turn.
// The same router handles 401/403 auth rejections: it refreshes the dead
// account once in place and replays, else quarantines it (NEEDS-RELOGIN)
// and retries the SAME request on the next healthy account.

/** Build the provider-scoped fetch the auth loader hands to the AI SDK.
 * Only requests made by the cline-free provider pass through it; the rest
 * of OpenCode (and other plugins) keep the untouched global fetch. */
export function createRoutedFetch(
  pool: PoolFile,
  log: Logger,
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  const origFetch = baseFetch

  return (async (input: any, init?: any): Promise<Response> => {
    let url: string
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : typeof input?.url === "string"
              ? input.url
              : ""
    } catch {
      return origFetch(input, init)
    }
    if (!isRoutableUrl(url)) return origFetch(input, init)

    // Normalize to replayable parts (chat bodies are small JSON).
    let method = "POST"
    let headers = new Headers()
    let body: ArrayBuffer | null = null
    let signal: AbortSignal | undefined
    try {
      if (typeof input === "string" || input instanceof URL) {
        method = init?.method ?? "POST"
        headers = new Headers(init?.headers)
        signal = init?.signal
        const b = init?.body
        if (typeof b === "string") body = new TextEncoder().encode(b).buffer as ArrayBuffer
        else if (b instanceof ArrayBuffer) body = b
        else if (ArrayBuffer.isView(b)) body = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
        else if (b != null) {
          // Non-replayable stream body: single attempt, no rotation.
          return origFetch(input, init)
        }
      } else {
        const req = input as Request
        method = req.method ?? init?.method ?? "POST"
        headers = new Headers(req.headers)
        for (const [k, v] of new Headers(init?.headers ?? {})) headers.set(k, v)
        signal = init?.signal ?? req.signal
        const buf = await req.clone().arrayBuffer().catch(() => null)
        body = buf && buf.byteLength > 0 ? buf : null
      }
    } catch {
      return origFetch(input, init)
    }

    const incomingAuth = headers.get("authorization") ?? ""
    const incomingToken = incomingAuth.replace(/^bearer\s+/i, "")
    const now = Date.now()
    const reqModel = modelOfRequest(url, body)
    // Paid models bill Cline credits: never fail over to another account or
    // replay for diagnostics. Same-account token refresh is still allowed.
    const paid = isPaidModel(reqModel)
    pruneLimits(pool, now)

    // First attempt keeps the loader-chosen identity; rotation only kicks
    // in after a 429, so the round-robin cursor advances once per request.
    const first =
      incomingToken && findByToken(pool, incomingToken)
        ? { token: incomingToken, accountId: findByToken(pool, incomingToken)!.id }
        : undefined

    const tried = new Set<string>()
    const refreshedInRequest = new Set<string>()
    let lastRes: Response | undefined
    let lastAuthRes: Response | undefined
    // Bound attempts: first identity + every other healthy candidate once.
    const maxAttempts = allCandidates(pool).length + 1

    const readSnippet = async (res: Response): Promise<string> => {
      try {
        return ((await res.clone().text().catch(() => "")) || "").slice(0, 300)
      } catch {
        return ""
      }
    }
    // A Response body can be consumed exactly once. Anything we store for a
    // later `return` (lastRes/lastAuthRes) must be cloned BEFORE the original
    // is drained — otherwise the caller gets an empty locked body and
    // surfaces "Failed to process error response". Discarded responses
    // (we `continue` to the next account) are drained to free the socket.
    const keepForReturn = (res: Response): Response => res.clone()
    const drain = async (res: Response): Promise<void> => {
      try {
        await res.arrayBuffer().catch(() => {})
      } catch {
        /* ignore */
      }
    }
    const cleanDetail = (snippet: string): string | undefined =>
      snippet.replace(/\s+/g, " ").trim().slice(0, 160) || undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (paid && tried.size > 0) break
      let token: string
      let accountId: string | undefined
      const firstAcc = first ? pool.accounts.find((a) => a.id === first.accountId) : undefined
      const firstLimited = firstAcc ? (modelLimitUntil(firstAcc, reqModel) ?? 0) > now : false
      if (attempt === 0 && first && !firstLimited) {
        ;({ token, accountId } = first)
      } else {
        if (attempt === 0 && !first && incomingToken) {
          // Unknown identity (manual header override): try it once as-is.
          token = incomingToken
        } else {
          const next = selectAccount(pool, Date.now(), reqModel)
          if (!next) break
          const t = tokenOf(next)
          if (!t || tried.has(next.id)) continue
          token = t
          accountId = next.id
        }
      }
      if (accountId) {
        if (tried.has(accountId)) continue
        tried.add(accountId)
      } else if (tried.has(`raw:${stripWorkOSPrefix(token)}`)) {
        continue
      } else {
        tried.add(`raw:${stripWorkOSPrefix(token)}`)
      }

      const h = new Headers(headers)
      h.set("authorization", `Bearer ${withWorkOSPrefix(token)}`)
      let res: Response
      try {
        res = await origFetch(url, { method, headers: h, body, signal })
      } catch (e) {
        throw e
      }

      // --- Auth recovery: Cline's generic session-reject body is
      // "Unauthorized: Please make sure you're using the latest version of
      // Cline and re-authenticate your Cline account." (HTTP 401). Tokens
      // are short-lived (~30 min), so a token that looked fresh in the
      // loader can be dead by request time — or revoked early when the same
      // Cline user refreshes elsewhere (VSCode/CLI/browser rotates the
      // refresh token, old copies get invalid_grant). Refresh once in place,
      // else quarantine this account and fail over to the next healthy one
      // (same transparent retry the 429 path already does).
      if (res.status === 401 || res.status === 403) {
        const snippet = await readSnippet(res)
        if (!isAuthFailure(res.status, snippet)) {
          if (accountId) {
            pool.activeId = accountId
            const acc = pool.accounts.find((a) => a.id === accountId)
            if (acc) {
              acc.lastUsed = Date.now()
              void savePoolFile(pool).catch(() => {})
            }
          }
          return res
        }
        const detail = cleanDetail(snippet)
        let acc = accountId ? pool.accounts.find((a) => a.id === accountId) : undefined
        // Stale cached identity: OpenCode's provider instance keeps the
        // loader's apiKey, so after the pool rotated a token (e.g. the
        // silent refresh below), later requests still arrive with the old
        // dead token — an identity findByToken no longer knows. Decode its
        // JWT user key and match it back to the owning account instead of
        // surfacing Cline's generic "re-authenticate" 401.
        let staleCache = false
        if (!acc) {
          const ukey = clineUserKey(token)
          const owner = ukey
            ? pool.accounts.find(
                (a) =>
                  a.refresh &&
                  tokenOf(a) &&
                  sameAccount(tokenOf(a)!, token) &&
                  (a.expires === undefined || a.expires - Date.now() > REFRESH_BUFFER_MS),
              )
            : undefined
          if (owner) {
            // The owner already holds a fresh token (rotated by an earlier
            // recovery): replay with it directly — no refresh rotation burn.
            staleCache = true
            accountId = owner.id
            acc = owner
            log("info", `cline-free: stale cached token (${maskToken(token)}) matched to ${owner.label ?? owner.id} by user key — replaying with its current session`)
          }
        }
        if (staleCache && acc) {
          const current = tokenOf(acc)!
          const h2 = new Headers(headers)
          h2.set("authorization", `Bearer ${withWorkOSPrefix(current)}`)
          const res2 = await origFetch(url, { method, headers: h2, body, signal })
          if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
            pool.activeId = acc.id
            acc.lastUsed = Date.now()
            void savePoolFile(pool).catch(() => {})
            log("info", `cline-free: request recovered on ${acc.label ?? acc.id} with its current session (stale cached token)`)
            await drain(res).catch(() => {})
            return res2
          }
          if (res2.status === 429) {
            const snippet2 = await readSnippet(res2)
            const detail2 = cleanDetail(snippet2)
            lastRes = keepForReturn(res2)
            await drain(res).catch(() => {})
            await drain(res2).catch(() => {})
            markAccountLimited(pool, acc.id, parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail2), log, detail2, reqModel)
            continue
          }
          // Current token is dead too: fall through to the forced refresh.
          lastAuthRes = keepForReturn(res2)
          await drain(res).catch(() => {})
          await drain(res2).catch(() => {})
        }
        if (acc?.refresh && !refreshedInRequest.has(acc.id)) {
          refreshedInRequest.add(acc.id)
          try {
            await refreshAccount(pool, acc, log)
            const fresh = tokenOf(acc)
            if (fresh) {
              const h2 = new Headers(headers)
              h2.set("authorization", `Bearer ${withWorkOSPrefix(fresh)}`)
              const res2 = await origFetch(url, { method, headers: h2, body, signal })
              if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
                pool.activeId = acc.id
                acc.lastUsed = Date.now()
                void savePoolFile(pool).catch(() => {})
                if (attempt > 0)
                  log("info", `cline-free: request recovered on ${acc.label ?? acc.id} after re-auth (attempt ${attempt + 1})`)
                else log("info", `cline-free: request recovered on ${acc.label ?? acc.id} after silent refresh`)
                await drain(res).catch(() => {})
                return res2
              }
              if (res2.status === 429) {
                const snippet2 = await readSnippet(res2)
                const detail2 = cleanDetail(snippet2)
                lastRes = keepForReturn(res2)
                await drain(res).catch(() => {})
                await drain(res2).catch(() => {})
                markAccountLimited(pool, acc.id, parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail2), log, detail2, reqModel)
                continue
              }
              const snippet2 = await readSnippet(res2)
              lastAuthRes = keepForReturn(res2)
              await drain(res).catch(() => {})
              await drain(res2).catch(() => {})
              quarantineAccount(
                pool,
                acc,
                `Cline rejected refreshed token (HTTP ${res2.status}${cleanDetail(snippet2) ? `: ${cleanDetail(snippet2)}` : ""})`,
                log,
              )
              continue
            }
          } catch (e) {
            lastAuthRes = keepForReturn(res)
            await drain(res).catch(() => {})
            if (e instanceof TerminalAuthError) {
              quarantineAccount(pool, acc, e.message, log)
            } else {
              log("warn", `cline-free: token refresh failed for ${acc.label ?? acc.id}: ${e instanceof Error ? e.message : String(e)} — trying next account`, { accountId: acc.id })
              acc.lastError = "refresh failed"
              void savePoolFile(pool).catch(() => {})
            }
            continue
          }
        }
        // No refresh token (manual/env token) or already refreshed this
        // request: this identity is dead — park it and try the next account.
        if (acc) {
          lastAuthRes = keepForReturn(res)
          await drain(res).catch(() => {})
          quarantineAccount(pool, acc, `Cline returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, log)
        } else {
          log("warn", `cline-free: 401/403 on untracked identity (${maskToken(token)})${detail ? ` — ${detail}` : ""}`)
          // Untracked identity can't fail over to anything known — surface
          // it untouched (no drain: the body must stay readable).
          return res
        }
        continue
      }

      if (res.status !== 429) {
        if (accountId) {
          pool.activeId = accountId
          const acc = pool.accounts.find((a) => a.id === accountId)
          if (acc) {
            acc.lastUsed = Date.now()
            void savePoolFile(pool).catch(() => {})
          }
        }
        if (attempt > 0) log("info", `cline-free: request recovered on ${pool.accounts.find((a) => a.id === accountId)?.label ?? "fallback account"} after 429/re-auth (attempt ${attempt + 1})`)
        return res
      }

      // 429: note the snippet, park this account (per model), try the next.
      const snippet = await readSnippet(res)
      lastRes = keepForReturn(res)
      await drain(res).catch(() => {})
      const retryAfter = parseRetryAfterMs(res) ?? parseRetryAfterFromBody(cleanDetail(snippet))
      const detail = cleanDetail(snippet)
      if (accountId && pool.accounts.some((a) => a.id === accountId)) {
        markAccountLimited(pool, accountId, retryAfter, log, detail, reqModel)
      } else {
        log("warn", `cline-free: 429 on untracked identity (${maskToken(token)})${detail ? ` — ${detail}` : ""}`)
        break
      }
    }

    if (lastAuthRes && !lastRes) {
      const quarantined = pool.accounts
        .filter((a) => a.authFailedAt)
        .map((a) => `${a.label ?? a.id}`)
        .join(", ")
      log("error", `cline-free: all ${tried.size} account(s) rejected auth (401/403). ${quarantined ? `Quarantined: ${quarantined}. ` : ""}Run /connect → cline-free and log in again; rotation continues when a healthy account exists.`)
      return lastAuthRes
    }

    if (lastRes) {
      const waiting = pool.accounts
        .filter((a) => a.limitedUntil && a.limitedUntil > Date.now())
        .map((a) => `${a.label ?? a.id}→${new Date(a.limitedUntil!).toISOString()}`)
        .join(", ")
      log("error", `cline-free: all ${tried.size} account(s) hit 429 daily quota. ${waiting ? `Cooling: ${waiting}. ` : ""}Add another Cline account via /connect to keep going.`)
      // Replay once on the earliest-reset account so the caller sees the
      // real server error body instead of a synthesized one.
      const earliest = [...pool.accounts]
        .filter((a) => tokenOf(a))
        .sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0))[0]
      const t = earliest ? tokenOf(earliest) : undefined
      if (!paid && earliest && t) {
        const h = new Headers(headers)
        h.set("authorization", `Bearer ${withWorkOSPrefix(t)}`)
        try {
          return await origFetch(url, { method, headers: h, body, signal })
        } catch (e) {
          throw e
        }
      }
      return lastRes
    }
    return origFetch(input, init)
  }) as typeof fetch
}
