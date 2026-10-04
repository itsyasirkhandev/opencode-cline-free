import { WORKOS_PREFIX } from "./constants.ts"
import { type Logger } from "./pool.ts"

export function withWorkOSPrefix(token: string): string {
  const t = token.trim()
  if (t.toLowerCase().startsWith(WORKOS_PREFIX)) return t
  // Cline API keys (sk_…) authenticate raw — the prefix is only valid for
  // OAuth access tokens, which are always JWTs.
  if (!t.startsWith("eyJ")) return t
  return `${WORKOS_PREFIX}${t}`
}

// --- Cline OAuth (WorkOS device-code flow, same as Pi's pi-cline) ---

// --- Production-grade auth plumbing (RFC 9700 §4.13, RFC 8628 §3.5) ---
//
// * Every token-endpoint call has a timeout: a hung socket must never hang
//   /connect or a model request forever.
// * Failures are classified terminal (retrying with the same credentials is
//   pointless — user must re-login) vs transient (the same request will
//   likely succeed on retry). Only invalid_* OAuth codes and other 4xx are
//   terminal; network errors, timeouts, 408/429/5xx and malformed-200
//   bodies are transient and retried with exponential backoff + jitter.

export const AUTH_TIMEOUT_MS = 15_000
export const TRANSIENT_MAX_ATTEMPTS = 4 // initial try + 3 retries
export const TRANSIENT_BACKOFF_MS = [300, 800, 2000]

export class TerminalAuthError extends Error {
  readonly kind = "terminal" as const
}

export class TransientAuthError extends Error {
  readonly kind = "transient" as const
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError")
  )
}

/** fetch with a timeout. Timeouts surface as TransientAuthError; an
 * outer-signal abort rethrows the caller's reason. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = AUTH_TIMEOUT_MS, signal: outer, ...rest } = init
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  if (outer) {
    if (outer.aborted) {
      clearTimeout(timer)
      throw (outer as AbortSignal).reason ?? new DOMException("Aborted", "AbortError")
    }
    outer.addEventListener("abort", onOuterAbort, { once: true })
  }
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal })
  } catch (e) {
    if (timedOut) throw new TransientAuthError(`request timed out after ${timeoutMs}ms: ${url}`)
    throw e
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener("abort", onOuterAbort)
  }
}

/** Best-effort OAuth error code from a parsed body ({error: "invalid_grant"}). */
export function parseOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const code = (body as { error?: unknown }).error
    if (typeof code === "string" && code) return code.toLowerCase()
  }
  return undefined
}

export function classifyHttpFailure(
  status: number | undefined,
  code: string | undefined,
  where: string,
  detail?: string,
): TerminalAuthError | TransientAuthError {
  const extra = detail ? `: ${detail}` : ""
  if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
    return new TerminalAuthError(`${where}: ${code}${extra} — re-login required (/connect → cline-free)`)
  }
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return new TransientAuthError(`${where}: HTTP ${status}${code ? ` (${code})` : ""}${extra}`)
  }
  if (status !== undefined && status >= 400) {
    return new TerminalAuthError(`${where}: HTTP ${status}${code ? ` (${code})` : ""}${extra} — retrying is unlikely to help`)
  }
  return new TransientAuthError(`${where}${extra}`)
}

/** Run fn, retrying transient failures with backoff. Terminal errors throw immediately. */
export async function withTransientRetries<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; label?: string; log?: Logger } = {},
): Promise<T> {
  const attempts = opts.attempts ?? TRANSIENT_MAX_ATTEMPTS
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof TerminalAuthError) throw e
      last = e
      if (attempt === attempts - 1) break
      const wait =
        TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)] + Math.random() * 250
      opts.log?.(
        "warn",
        `cline-free: attempt ${attempt + 1}/${attempts} failed${opts.label ? ` for ${opts.label}` : ""} (${e instanceof Error ? e.message : String(e)}) — retrying in ${Math.round(wait)}ms`,
      )
      await sleep(wait)
    }
  }
  if (last instanceof TerminalAuthError) throw last
  throw last instanceof Error ? last : new TransientAuthError(`operation failed: ${String(last)}`)
}
