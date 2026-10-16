import { REFRESH_BUFFER_MS } from "./constants.ts"
import { TerminalAuthError, withWorkOSPrefix } from "./http.ts"
import { isPaidModel } from "./models.ts"
import { type Logger, type PoolFile, allCandidates, clineUserKey, cooldownUntil, findAccount, findByToken, isAvailable, isAuthFailure, isRoutableUrl, markAccountLimited, markNoCredits, maskToken, modelOfRequest, parseRetryAfterFromBody, parseRetryAfterMs, pinSession, pruneLimits, quarantineAccount, refreshAccount, sameAccount, savePoolFile, selectAccount, stripWorkOSPrefix, tokenOf } from "./pool.ts"

export type RouterOptions = {
  /** Session of the request: the account that serves it becomes the
   * session's pinned account for the request's model. */
  sessionID?: string
}

/** Retries on other accounts must not hang forever: give up when no response
 * headers arrive in time (the stream itself is never cut off). */
export const RETRY_HEADERS_TIMEOUT_MS = 120_000

// --- Transparent same-request 429 + 401 + 402 failover ---
//
// OpenCode's AI SDK performs the HTTPS call with the apiKey the loader
// returned. When Cline answers 429 we swap in the next healthy account and
// replay the request, so one exhausted daily quota doesn't fail the turn.
// The same router handles 401/403 auth rejections: it refreshes the dead
// account once in place and replays, else quarantines it (NEEDS-RELOGIN)
// and retries the SAME request on the next healthy account.
// Paid models also fail over on 402 `insufficient_credits` (Cline rejects
// before billing): the account is skipped for paid models until restart.

/** Build the provider-scoped fetch the auth loader hands to the AI SDK.
 * Only requests made by the cline-free provider pass through it; the rest
 * of OpenCode (and other plugins) keep the untouched global fetch. */
export function createRoutedFetch(
  pool: PoolFile,
  log: Logger,
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
  opts: RouterOptions = {},
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

    // Let Request apply fetch's override rules (including replacement, not
    // merging, of headers). Explicit streaming init bodies are single-shot:
    // pass them through untouched rather than risk replaying partial data.
    if (init?.body instanceof ReadableStream) return origFetch(input, init)
    const request = new Request(input, init)
    const method = request.method
    const headers = new Headers(request.headers)
    const signal = request.signal
    signal.throwIfAborted()
    let body: ArrayBuffer | null = null
    if (request.body) {
      const reader = request.body.getReader()
      let onAbort: () => void = () => {}
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(signal.reason)
          void reader.cancel(signal.reason).catch(() => {})
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try {
        body = await Promise.race([
          (async () => {
            try {
              const chunks: Uint8Array[] = []
              let length = 0
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                chunks.push(value)
                length += value.byteLength
              }
              const bytes = new Uint8Array(length)
              let offset = 0
              for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.length
              }
              return bytes.buffer
            } finally {
              reader.releaseLock()
            }
          })(),
          aborted,
        ])
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
    signal.throwIfAborted()
    const replayInit: RequestInit = {
      ...init,
      method,
      headers,
      body,
      signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    }

    const incomingAuth = headers.get("authorization") ?? ""
    const incomingToken = incomingAuth.replace(/^bearer\s+/i, "")
    const now = Date.now()
    const reqModel = modelOfRequest(url, body)
    // Paid models bill Cline credits: they fail over like free models (Cline
    // rejects 402/429 before billing), but are never replayed for diagnostics.
    const paid = isPaidModel(reqModel)
    pruneLimits(pool, now)

    // First attempt keeps the loader-chosen identity (the session's pinned
    // account); rotation only kicks in after a 429/402/401.
    const firstOwner = incomingToken ? findByToken(pool, incomingToken) : undefined
    const first = firstOwner ? { token: incomingToken, accountId: firstOwner.id } : undefined

    const tried = new Set<string>()
    const refreshedInRequest = new Set<string>()
    let lastRes: Response | undefined
    let lastAuthRes: Response | undefined
    // Bound attempts: first identity + every other healthy candidate once.
    const maxAttempts = allCandidates(pool).length + 1

    const readSnippet = async (res: Response): Promise<string> => {
      try {
        return (
          (await res
            .clone()
            .text()
            .catch(() => "")) || ""
        ).slice(0, 300)
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
    // 402 `insufficient_credits` on a paid model: keep the body for the
    // caller, park the account for paid models, try the next one.
    const outOfCredits = (res: Response) => paid && res.status === 402
    const parkNoCredits = async (res: Response, id: string) => {
      const detail = cleanDetail(await readSnippet(res))
      lastRes = keepForReturn(res)
      await drain(res).catch(() => {})
      markNoCredits(pool, id, log, detail)
    }
    // The account that answered: remember it as active and as the session's
    // pin for this model, so the next turn reuses its warm prompt cache.
    const served = (id: string | undefined) => {
      if (!id) return
      pool.activeId = id
      const acc = findAccount(pool, id)
      if (acc) {
        acc.lastUsed = Date.now()
        void savePoolFile(pool).catch(() => {})
      }
      if (opts.sessionID) pinSession(pool, opts.sessionID, reqModel, id)
    }
    // Every send after the first is a retry the caller never asked for.
    // Stop when the caller cancelled, and bound the wait for headers so a
    // stuck retry can't hold (or bill) the turn indefinitely.
    let sends = 0
    const send = async (token?: string): Promise<Response> => {
      signal.throwIfAborted()
      const h = new Headers(headers)
      if (token) h.set("authorization", `Bearer ${withWorkOSPrefix(token)}`)
      const sendInit = { ...replayInit, headers: h, body: body?.slice(0) ?? null }
      if (sends++ === 0) return origFetch(url, sendInit)
      const ctrl = new AbortController()
      const timer = setTimeout(
        () => ctrl.abort(new Error(`cline-free: retry got no response within ${RETRY_HEADERS_TIMEOUT_MS / 1000}s`)),
        RETRY_HEADERS_TIMEOUT_MS,
      )
      try {
        // any() keeps caller cancellation connected during response streaming,
        // without leaking a per-retry event listener after headers arrive.
        return await origFetch(url, { ...sendInit, signal: AbortSignal.any([signal, ctrl.signal]) })
      } finally {
        clearTimeout(timer)
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let token: string
      let accountId: string | undefined
      const firstAcc = first ? findAccount(pool, first.accountId) : undefined
      const firstLimited = firstAcc ? !isAvailable(pool, firstAcc, now, reqModel) || !!firstAcc.authFailedAt : false
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

      const res = await send(token)

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
          served(accountId)
          return res
        }
        const detail = cleanDetail(snippet)
        let acc = findAccount(pool, accountId)
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
            log(
              "info",
              `cline-free: stale cached token (${maskToken(token)}) matched to ${owner.label ?? owner.id} by user key — replaying with its current session`,
            )
          }
        }
        if (staleCache && acc) {
          const res2 = await send(tokenOf(acc)!)
          if (outOfCredits(res2)) {
            await drain(res).catch(() => {})
            await parkNoCredits(res2, acc.id)
            continue
          }
          if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
            served(acc.id)
            log(
              "info",
              `cline-free: request recovered on ${acc.label ?? acc.id} with its current session (stale cached token)`,
            )
            await drain(res).catch(() => {})
            return res2
          }
          if (res2.status === 429) {
            const snippet2 = await readSnippet(res2)
            const detail2 = cleanDetail(snippet2)
            lastRes = keepForReturn(res2)
            await drain(res).catch(() => {})
            await drain(res2).catch(() => {})
            markAccountLimited(
              pool,
              acc.id,
              parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail2),
              log,
              detail2,
              reqModel,
            )
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
              const res2 = await send(fresh)
              if (outOfCredits(res2)) {
                await drain(res).catch(() => {})
                await parkNoCredits(res2, acc.id)
                continue
              }
              if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
                served(acc.id)
                if (attempt > 0)
                  log(
                    "info",
                    `cline-free: request recovered on ${acc.label ?? acc.id} after re-auth (attempt ${attempt + 1})`,
                  )
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
                markAccountLimited(
                  pool,
                  acc.id,
                  parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail2),
                  log,
                  detail2,
                  reqModel,
                )
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
              log(
                "warn",
                `cline-free: token refresh failed for ${acc.label ?? acc.id}: ${e instanceof Error ? e.message : String(e)} — trying next account`,
                { accountId: acc.id },
              )
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

      // Env accounts count as tracked: they fail over and cool down too.
      if (outOfCredits(res) && accountId && findAccount(pool, accountId)) {
        await parkNoCredits(res, accountId)
        continue
      }

      if (res.status !== 429) {
        served(accountId)
        if (attempt > 0)
          log(
            "info",
            `cline-free: request recovered on ${findAccount(pool, accountId)?.label ?? "fallback account"} after 429/402/re-auth (attempt ${attempt + 1})`,
          )
        return res
      }

      // 429: note the snippet, park this account (per model), try the next.
      const snippet = await readSnippet(res)
      lastRes = keepForReturn(res)
      await drain(res).catch(() => {})
      const retryAfter = parseRetryAfterMs(res) ?? parseRetryAfterFromBody(cleanDetail(snippet))
      const detail = cleanDetail(snippet)
      if (accountId && findAccount(pool, accountId)) {
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
      log(
        "error",
        `cline-free: all ${tried.size} account(s) rejected auth (401/403). ${quarantined ? `Quarantined: ${quarantined}. ` : ""}Run /connect → cline-free and log in again; rotation continues when a healthy account exists.`,
      )
      return lastAuthRes
    }

    if (lastRes && paid) {
      log(
        "error",
        `cline-free: no account could serve paid model ${reqModel} (all ${tried.size} tried are out of Cline credits or rate limited). Add credits or another Cline account via /connect.`,
      )
      return lastRes
    }

    if (lastRes) {
      const waiting = pool.accounts
        .filter((a) => cooldownUntil(a) > Date.now())
        .map((a) => `${a.label ?? a.id}→${new Date(cooldownUntil(a)).toISOString()}`)
        .join(", ")
      log(
        "error",
        `cline-free: all ${tried.size} account(s) hit 429 daily quota. ${waiting ? `Cooling: ${waiting}. ` : ""}Add another Cline account via /connect to keep going.`,
      )
      // Replay once on the earliest-reset account (for this model when
      // known) so the caller sees the real server error body instead of a
      // synthesized one. Only rotation candidates qualify: an account that
      // needs re-login would answer 401 and hide the real quota error.
      const resetOf = (a: PoolFile["accounts"][number]) => cooldownUntil(a, reqModel)
      const earliest = allCandidates(pool).sort((a, b) => resetOf(a) - resetOf(b))[0]
      const t = earliest ? tokenOf(earliest) : undefined
      if (earliest && t) return await send(t)
      return lastRes
    }
    return send(incomingToken || undefined)
  }) as typeof fetch
}

/** Statuses the router recovers from (auth refresh / account failover).
 * 402 only fails over for paid models; the router returns it otherwise. */
export function needsFailover(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429
}

/** Recover a response that already came back (V2 `http.response` hook).
 * Runs the same router as a fetch wrapper, except the first attempt with the
 * original identity reuses the response we already have instead of sending
 * the request again; every later attempt (refresh, next account) is a real
 * request. Responses that need no recovery are returned untouched. */
export async function recoverResponse(
  pool: PoolFile,
  log: Logger,
  request: Request,
  response: Response,
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
  opts: RouterOptions = {},
): Promise<Response> {
  if (!needsFailover(response.status) || !isRoutableUrl(request.url)) return response
  const originalAuth = request.headers.get("authorization") ?? ""
  let reused = false
  const replayFetch = (async (input: any, init?: any): Promise<Response> => {
    const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? ""
    if (!reused && auth === originalAuth) {
      reused = true
      return response
    }
    return baseFetch(input, init)
  }) as typeof fetch
  return createRoutedFetch(pool, log, replayFetch, opts)(request)
}
