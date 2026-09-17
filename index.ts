import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * opencode-cline-free
 *
 * Exposes Cline's rotating free models inside OpenCode through your
 * Cline account (same account/quota you see in Cline VSCode/CLI).
 *
 * Live list: GET https://api.cline.bot/api/v1/ai/cline/recommended-models
 * As of 2026-09-15 the `free` array is:
 * - cline-free/deepseek-v4.1-flash
 * - cline-free/muse-spark-1.3-contributor
 * - z-ai/glm-5.3-flash
 * - cline-free/solar-pro4
 * - poolside/laguna-s-2.1:free
 * (glm-5.3-flash + laguna overlap with Zen, the other 3 are Cline-only free.)
 * Note: deepseek/deepseek-v4-flash (2026-09-13) has rotated out; kept as
 * a known id for stale configs.
 */

const PROVIDER_ID = "cline-free"
const API_BASE = "https://api.cline.bot"
const CHAT_BASE_URL = `${API_BASE}/api/v1`
const RECOMMENDED_URL = `${API_BASE}/api/v1/ai/cline/recommended-models`

// Public WorkOS client id used by Cline's own OAuth flows
// (same value the Pi `pi-cline` extension uses).
const WORKOS_API = "https://api.workos.com"
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"
const WORKOS_PREFIX = "workos:"
const REFRESH_BUFFER_MS = 5 * 60 * 1000

// --- Multi-account pool ---
// OpenCode stores a single Auth per provider id, so extra Cline accounts
// live in a plugin-managed pool file next to auth.json
// (~/.local/share/opencode/cline-free-accounts.json). The loader picks the
// next healthy account and a fetch wrapper retries the SAME request on a
// different account when Cline answers 429.
const ACCOUNTS_FILE_NAME = "cline-free-accounts.json"
const DAY_MS = 24 * 60 * 60 * 1000

type FreeEntry = { id: string; name?: string; description?: string }
type RecommendedPayload = {
  recommended?: FreeEntry[]
  free?: FreeEntry[]
  clinePass?: FreeEntry[]
}

// Fallback so the provider still registers when offline.
// Refreshed from the live endpoint on every startup (see fetchFreeModels).
const FALLBACK_FREE: FreeEntry[] = [
  {
    id: "cline-free/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    description:
      "Sparse MoE (CED architecture) with native image understanding and 1M context window.",
  },
  {
    id: "cline-free/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    description:
      "Meta's multimodal reasoning model for experimentation and agentic coding workflows.",
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    description: "Latest natively multimodal model in the GLM-5 series.",
  },
  {
    id: "cline-free/solar-pro4",
    name: "Solar Pro 4",
    description: "Strong model for office productivity and coding.",
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1 (free)",
    description: "Latest coding agent model from Poolside.",
  },
]

// Best-effort context/output limits (OpenCode only uses these for
// budgeting/truncation; the server remains authoritative).
// Sources: models.dev canonical entries + nano-gpt provider entries for
// deepseek-v4.1-flash; output values use the conservative free-tier caps.
// Reference vendor rates ($/1M tokens, nano-gpt canonical where available).
// Display-only: Cline bills these ids at $0 via free quota, so the
// injected cost uses input/output/cache_read for stats display with
// cache_write 0 (no vendor publishes a write rate for these).
const COSTS: Record<string, { input: number; output: number; cache_read: number }> = {
  "cline-free/muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cache_read: 0.002 },
  "cline-free/deepseek-v4.1-flash": { input: 0.1, output: 0.4, cache_read: 0.003 },
  "deepseek/deepseek-v4.1-flash": { input: 0.1, output: 0.4, cache_read: 0.003 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.0028 },
  "z-ai/glm-5.3-flash": { input: 0.075, output: 0.25, cache_read: 0.015 },
  "cline-free/solar-pro4": { input: 0.03, output: 0.12, cache_read: 0.006 },
  "poolside/laguna-s-2.1:free": { input: 0.1, output: 0.2, cache_read: 0.01 },
}
const DEFAULT_COST = { input: 0, output: 0, cache_read: 0 }
const LIMITS: Record<string, { context: number; output: number }> = {
  "cline-free/muse-spark-1.3-contributor": { context: 1_048_576, output: 131_072 },
  "cline-free/deepseek-v4.1-flash": { context: 1_000_000, output: 384_000 },
  "deepseek/deepseek-v4.1-flash": { context: 1_000_000, output: 384_000 },
  "deepseek/deepseek-v4-flash": { context: 1_048_576, output: 384_000 },
  "z-ai/glm-5.3-flash": { context: 1_048_576, output: 131_072 },
  "cline-free/solar-pro4": { context: 524_288, output: 131_072 },
  "poolside/laguna-s-2.1:free": { context: 256_000, output: 32_000 },
}
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 }

// Multimodal input per models.dev canonical entries; output is text-only.
// - deepseek-v4.1-flash: text+image input (native vision, joint embeddings);
//   the older v4-flash lane was text-only.
// - muse-spark keeps video/audio/pdf per vendor docs (models.dev only says image).
const INPUT_MODALITIES: Record<string, string[]> = {
  "cline-free/muse-spark-1.3-contributor": ["text", "image", "video", "audio", "pdf"],
  "cline-free/deepseek-v4.1-flash": ["text", "image"],
  "deepseek/deepseek-v4.1-flash": ["text", "image"],
  "deepseek/deepseek-v4-flash": ["text"],
  "z-ai/glm-5.3-flash": ["text", "image", "video"],
  "cline-free/solar-pro4": ["text"],
  "poolside/laguna-s-2.1:free": ["text"],
}

// Valid reasoning efforts:
// - deepseek-v4.1-flash canonical reasoning_options (models.dev nano-gpt):
//   none/low/high/max (NO medium — server maps/validates; v4-flash generic
//   accepted low/medium/high/max on 2026-09-13 probes, keep for stale id).
// - every other free model accepts low/medium/high/max EXCEPT
//   muse-spark-1.3 (accepts minimal/low/medium/high/xhigh;
//   `max` → HTTP 500 invalid_request_error from Meta via OpenRouter)
// - glm officially documents low/high/max only (medium is accepted but
//   mapped to max by the companion reasoning hook)
// - laguna exposes only off/max (max is default) → no variants
const VARIANTS: Record<string, string[]> = {
  "cline-free/muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  "cline-free/deepseek-v4.1-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-flash": ["low", "medium", "high", "max"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "cline-free/solar-pro4": ["low", "medium", "high", "max"],
  "poolside/laguna-s-2.1:free": [],
}

function withWorkOSPrefix(token: string): string {
  const t = token.trim()
  if (t.toLowerCase().startsWith(WORKOS_PREFIX)) return t
  // Cline API keys (sk_…) authenticate raw — the prefix is only valid for
  // OAuth access tokens, which are always JWTs.
  if (!t.startsWith("eyJ")) return t
  return `${WORKOS_PREFIX}${t}`
}

function displayName(entry: FreeEntry): string {
  const base = (entry.name?.trim() || entry.id).trim()
  return base.toLowerCase().includes("free") ? base : `${base} (free)`
}

function modelConfig(entry: FreeEntry) {
  const limit = LIMITS[entry.id] ?? DEFAULT_LIMIT
  const levels = VARIANTS[entry.id] ?? ["low", "medium", "high", "max"]
  const cost = COSTS[entry.id] ?? DEFAULT_COST
  const variants: Record<string, { reasoningEffort: string }> = {}
  for (const level of levels) variants[level] = { reasoningEffort: level }
  return {
    name: displayName(entry),
    limit: { context: limit.context, output: limit.output },
    modalities: { input: INPUT_MODALITIES[entry.id] ?? ["text"], output: ["text"] },
    tool_call: true,
    reasoning: true,
    cost: { input: cost.input, output: cost.output, cache_read: cost.cache_read, cache_write: 0 },
    ...(levels.length > 0 ? { variants } : {}),
  }
}

async function fetchFreeModels(timeoutMs = 12_000): Promise<FreeEntry[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(RECOMMENDED_URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "opencode-cline-free" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = (await res.json()) as RecommendedPayload
    const free = (payload.free ?? []).filter((m) => typeof m?.id === "string" && m.id.length > 0)
    return free.length > 0 ? free : FALLBACK_FREE
  } catch {
    return FALLBACK_FREE
  } finally {
    clearTimeout(timer)
  }
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

const AUTH_TIMEOUT_MS = 15_000
const TRANSIENT_MAX_ATTEMPTS = 4 // initial try + 3 retries
const TRANSIENT_BACKOFF_MS = [300, 800, 2000]

class TerminalAuthError extends Error {
  readonly kind = "terminal" as const
}

class TransientAuthError extends Error {
  readonly kind = "transient" as const
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError")
  )
}

/** fetch with a timeout. Timeouts surface as TransientAuthError; an
 * outer-signal abort rethrows the caller's reason. */
async function fetchWithTimeout(
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
function parseOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const code = (body as { error?: unknown }).error
    if (typeof code === "string" && code) return code.toLowerCase()
  }
  return undefined
}

function classifyHttpFailure(
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
async function withTransientRetries<T>(
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

async function startDeviceAuth() {
  const res = await withTransientRetries(
    () =>
      fetchWithTimeout(`${WORKOS_API}/user_management/authorize/device`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
      }),
    { attempts: 2, label: "device authorization" },
  )
  const data = (await res.json().catch(() => ({}))) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
    throw classifyHttpFailure(
      res.ok ? undefined : res.status,
      parseOAuthErrorCode(data),
      "Cline device authorization",
      data.error_description ?? (typeof data.error === "string" ? data.error : undefined) ?? res.statusText,
    )
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresInSeconds: data.expires_in ?? 300,
    intervalSeconds: data.interval ?? 5,
  }
}

async function pollDeviceAuth(deviceCode: string, expiresInSeconds: number, intervalSeconds: number) {
  // Stop polling slightly before the code dies — never fire a doomed last poll.
  const deadline = Date.now() + Math.max(30, expiresInSeconds - 10) * 1000
  let interval = Math.max(1, intervalSeconds)
  while (Date.now() <= deadline) {
    let res: Response
    try {
      res = await fetchWithTimeout(`${WORKOS_API}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: WORKOS_CLIENT_ID,
        }),
      })
    } catch (e) {
      if (isAbortError(e)) throw e
      // Transient blip on one poll must not kill the whole flow — wait out
      // this interval and try again (bounded by the deadline above).
      await new Promise((r) => setTimeout(r, interval * 1000))
      continue
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      error?: string
      error_description?: string
    }
    if (res.ok && data.access_token && data.refresh_token) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token }
    }
    if (data.error === "authorization_pending") {
      await new Promise((r) => setTimeout(r, interval * 1000))
      continue
    }
    if (data.error === "slow_down") {
      interval += 5
      await new Promise((r) => setTimeout(r, interval * 1000))
      continue
    }
    if (data.error === "access_denied") {
      throw new TerminalAuthError("Cline device authorization denied in the browser — run /connect again and approve the prompt.")
    }
    if (data.error === "expired_token") {
      throw new TerminalAuthError("Cline device code expired before approval — run /connect again for a fresh code.")
    }
    throw new TerminalAuthError(`Cline device authorization failed: ${data.error_description ?? data.error ?? res.statusText}`)
  }
  throw new Error("Cline device authorization timed out — run /connect again and approve the browser prompt.")
}

async function registerWorkOSTokens(tokens: { accessToken: string; refreshToken: string }) {
  return withTransientRetries(
    async () => {
      const res = await fetchWithTimeout(`${API_BASE}/api/v1/auth/register`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(tokens),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let code: string | undefined
        let detail = `${res.status} ${res.statusText}`
        if (text) {
          try {
            const j = JSON.parse(text) as { error_description?: string; message?: string; error?: string }
            code = typeof j.error === "string" ? j.error.toLowerCase() : undefined
            detail = (j.error_description ?? j.message ?? j.error ?? text).slice(0, 200)
          } catch {
            detail = text.slice(0, 200)
          }
        }
        throw classifyHttpFailure(res.status, code, "Cline token registration", detail)
      }
      const payload = (await res.json()) as {
        success?: boolean
        data?: { accessToken?: string; refreshToken?: string; expiresAt?: string }
      }
      const data = payload.data
      if (!payload.success || !data?.accessToken || !data?.expiresAt) {
        throw new TransientAuthError("Invalid token response from Cline")
      }
      const expires = Date.parse(data.expiresAt)
      if (Number.isNaN(expires)) throw new TransientAuthError(`Invalid token expiration from Cline: ${data.expiresAt}`)
      return {
        access: data.accessToken,
        refresh: data.refreshToken ?? tokens.refreshToken,
        expires: expires - REFRESH_BUFFER_MS,
      }
    },
    { attempts: 3, label: "token registration" },
  )
}

type RefreshResult = { access: string; refresh: string; expires: number }

/** Single refresh attempt. Throws TerminalAuthError (re-login required,
 * do not retry) or TransientAuthError (same refresh token is safe to
 * retry — rotation grace windows tolerate this). */
async function refreshClineTokenOnce(
  refresh: string,
  post: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetchWithTimeout(url, init),
): Promise<RefreshResult> {
  let res: Response
  try {
    res = await post(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh, grantType: "refresh_token" }),
    })
  } catch (e) {
    if (e instanceof TerminalAuthError) throw e
    if (isAbortError(e)) throw e
    throw new TransientAuthError(`Cline token refresh failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let code: string | undefined
    let detail = `${res.status} ${res.statusText}`
    if (text) {
      try {
        const j = JSON.parse(text) as { error_description?: string; message?: string; error?: string }
        code = typeof j.error === "string" ? j.error.toLowerCase() : undefined
        detail = (j.error_description ?? j.message ?? j.error ?? text).slice(0, 200)
      } catch {
        detail = text.slice(0, 200)
      }
    }
    throw classifyHttpFailure(res.status, code, "Cline token refresh", detail)
  }
  const payload = (await res.json()) as {
    success?: boolean
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string }
  }
  const data = payload.data
  if (!payload.success || !data?.accessToken || !data?.expiresAt) {
    throw new TransientAuthError("Invalid refresh response from Cline")
  }
  const expires = Date.parse(data.expiresAt)
  if (Number.isNaN(expires)) throw new TransientAuthError("Invalid token expiration from Cline")
  return { access: data.accessToken, refresh: data.refreshToken ?? refresh, expires: expires - REFRESH_BUFFER_MS }
}

/** Refresh with bounded retries on transient failures. Terminal errors
 * (invalid_grant et al.) throw immediately — the account needs re-login. */
async function refreshClineToken(
  refresh: string,
  opts: {
    label?: string
    log?: Logger
    post?: (url: string, init: RequestInit) => Promise<Response>
  } = {},
): Promise<RefreshResult> {
  return withTransientRetries(() => refreshClineTokenOnce(refresh, opts.post), {
    label: opts.label ? `token refresh for ${opts.label}` : "token refresh",
    log: opts.log,
  })
}

// --- Reuse an existing Cline CLI login on this machine ---
//
// Cline CLI stores its OAuth session at ~/.cline/data/settings/providers.json
// (honors CLINE_DATA_DIR / CLINE_DIR overrides). If present, we import the
// tokens directly — no browser round-trip, the user just confirms.

type ClineCliAuth = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number | string
  metadata?: { userInfo?: { email?: string } }
}

type ClineProvidersFile = {
  providers?: Record<string, { settings?: { auth?: ClineCliAuth } }>
}

function clineProvidersFileCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const candidates: string[] = []
  const dataDir = process.env.CLINE_DATA_DIR
  if (dataDir) candidates.push(`${dataDir}/settings/providers.json`)
  const clineDir = process.env.CLINE_DIR
  if (clineDir) {
    candidates.push(`${clineDir}/data/settings/providers.json`)
    candidates.push(`${clineDir}/settings/providers.json`)
  }
  if (home) {
    candidates.push(`${home}/.cline/data/settings/providers.json`)
    candidates.push(`${home}/.cline/settings/providers.json`)
  }
  return candidates
}

async function readClineCliSession(): Promise<
  { access: string; refresh: string; expires: number; email?: string } | undefined
> {
  const { readFile } = await import("node:fs/promises")
  for (const file of clineProvidersFileCandidates()) {
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch {
      continue
    }
    try {
      const data = JSON.parse(raw) as ClineProvidersFile
      const auth = data.providers?.cline?.settings?.auth
      const accessToken = auth?.accessToken?.trim()
      if (!accessToken) continue
      const rawExpires = auth?.expiresAt
      const expiresAt =
        typeof rawExpires === "number"
          ? rawExpires < 1e12
            ? rawExpires * 1000
            : rawExpires
          : typeof rawExpires === "string"
            ? Date.parse(rawExpires)
            : NaN
      return {
        access: accessToken.replace(/^workos:/i, ""),
        refresh: auth?.refreshToken?.trim() ?? "",
        expires: Number.isNaN(expiresAt) ? 0 : expiresAt - REFRESH_BUFFER_MS,
        email: auth?.metadata?.userInfo?.email,
      }
    } catch {
      continue
    }
  }
  return undefined
}

async function validateClineToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${withWorkOSPrefix(accessToken)}`, Accept: "application/json" },
    })
    return res.ok
  } catch {
    return false
  }
}

// --- Multi-account pool + 429 router ---
//
// Why a pool file: OpenCode keeps exactly one Auth per provider id, so a
// second `/connect` would overwrite the first. Every successful login
// (oauth device flow, CLI import, manual token) is therefore APPENDED to
// the pool, and the loader + fetch wrapper rotate across it.

type AccountSource = "oauth" | "api" | "env" | "cli"

type PoolAccount = {
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

type PoolFile = { version: 1; activeId?: string; accounts: PoolAccount[] }

/** Per-model 429 cooldowns make selectAccount model-aware: the router
 * extracts the model from the chat body and picks an account that still
 * has quota for THAT model. */
function modelOfRequest(url: string, body: ArrayBuffer | null): string | undefined {
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
function modelLimitUntil(acc: PoolAccount, model: string | undefined): number | undefined {
  if (!model || !acc.modelLimits) return undefined
  const until = acc.modelLimits[model]
  return typeof until === "number" ? until : undefined
}

function poolFilePath(): string {
  const override = process.env.CLINE_FREE_ACCOUNTS_FILE?.trim()
  if (override) return override
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const dataDir =
    process.env.XDG_DATA_HOME?.trim() ||
    (home ? `${home}/.local/share/opencode` : "")
  if (dataDir) return `${dataDir}/${ACCOUNTS_FILE_NAME}`
  return `./${ACCOUNTS_FILE_NAME}`
}

function stripWorkOSPrefix(token: string): string {
  return token.trim().replace(/^workos:/i, "")
}

function sameToken(a: string, b: string): boolean {
  return stripWorkOSPrefix(a) === stripWorkOSPrefix(b)
}

/** Same Cline user (stable identity), even across token rotations. */
function sameAccount(a: string, b: string): boolean {
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
function b64UrlDecodeToString(b64url: string): string {
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

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const raw = stripWorkOSPrefix(token).trim()
    const parts = raw.split(".")
    if (parts.length < 2 || !parts[1]) return undefined
    return JSON.parse(b64UrlDecodeToString(parts[1])) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function clineUserKey(token: string): string | undefined {
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

function payloadEmail(token: string): string | undefined {
  const p = decodeJwtPayload(token)
  const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : ""
  return email.includes("@") ? email : undefined
}

function normalizeEmailLabel(label?: string): string | undefined {
  if (!label) return undefined
  const t = label.trim().toLowerCase()
  return t.includes("@") ? t : undefined
}

function accountEmail(a: PoolAccount): string | undefined {
  return normalizeEmailLabel(a.label) ?? (tokenOf(a) ? payloadEmail(tokenOf(a)!) : undefined)
}

function freshnessOf(a: PoolAccount): number {
  return Math.max(a.expires ?? 0, a.lastUsed ?? 0, a.addedAt ?? 0)
}

function isGenericLabel(label?: string): boolean {
  if (!label) return true
  const t = label.trim()
  if (!t) return true
  if (t.includes("@")) return false
  return /^(cline-\d+|token-…|token-|connect-token|account-\d+)$/i.test(t) || t.length <= 8
}

function maskToken(token: string): string {
  const t = stripWorkOSPrefix(token)
  if (t.length <= 10) return "…"
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

function newAccountId(): string {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function nextUtcMidnightMs(now = Date.now(), bufferMs = 5 * 60 * 1000): number {
  const d = new Date(now)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime() + bufferMs
}

function parseRetryAfterMs(res: Response): number | undefined {
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
function parseRetryAfterFromBody(detail: string | undefined): number | undefined {
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

function isRoutableUrl(url: string): boolean {
  return (
    url.startsWith(API_BASE) &&
    (url.includes("/chat/completions") || url.includes("/completions"))
  )
}

/** True when a 401/403 body looks like a dead session (not a permission /
 * retired-model error). 401 is always treated as auth; 403 only when the
 * body says so, so real 403s (no access to resource) stay visible. */
function isAuthFailure(status: number, snippet: string): boolean {
  if (status === 401) return true
  if (status !== 403) return false
  return /unauthor|re-authenticate|reauthenticate|invalid_grant|invalid_token|expired|please .* (login|authenticate)/i.test(
    snippet,
  )
}

async function loadPoolFile(): Promise<PoolFile> {
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

async function savePoolFile(pool: PoolFile): Promise<void> {
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
async function withFileLock<T>(fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const { open, unlink, stat } = await import("node:fs/promises")
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
  try {
    return await fn()
  } finally {
    await unlink(lock).catch(() => {})
  }
}

function pruneLimits(pool: PoolFile, now = Date.now()): boolean {
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
function splitEnvList(value: string): string[] {
  return value.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length >= 10)
}

function collectEnvKeys(): string[] {
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

function tokenOf(a: PoolAccount): string | undefined {
  return a.access ?? a.apiKey
}

/** Pool accounts plus ephemeral env accounts, deduped by user then token.
 * Same Cline user with two sessions shares one daily quota, so only the
 * freshest entry per user is a rotation candidate. */
function allCandidates(pool: PoolFile): PoolAccount[] {
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
function dedupePool(pool: PoolFile): boolean {
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

function findOAuthDuplicate(
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

function findByToken(pool: PoolFile, token: string): PoolAccount | undefined {
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

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
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

type Logger = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Clear all health state: cooldowns, errors, and auth quarantine.
 * Called whenever fresh credentials land for an account. */
function clearAuthHealth(acc: PoolAccount): void {
  delete acc.limitedUntil
  delete acc.lastError
  delete acc.authFailedAt
  delete acc.authFailedReason
  delete acc.lastProbeAt
}

function upsertOAuthAccount(
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

function upsertApiAccount(pool: PoolFile, key: string, label?: string, source: AccountSource = "api"): PoolAccount {
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
async function refreshAccount(pool: PoolFile, acc: PoolAccount, log: Logger): Promise<void> {
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
function quarantineAccount(pool: PoolFile, acc: PoolAccount, reason: string, log: Logger): void {
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

const PROBE_INTERVAL_MS = 15 * 60 * 1000

/** Self-healing for quarantines (covers misclassification): at most every
 * 15 min per account, re-validate a quarantined account whose stored access
 * token still looks usable. A pass returns it to rotation. */
async function probeQuarantinedAccounts(pool: PoolFile, log: Logger): Promise<void> {
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
let rrCursor = 0

/** Next healthy account in round-robin order; undefined when all limited.
 * With `model`, only accounts whose per-model quota is intact qualify. */
function selectAccount(pool: PoolFile, now = Date.now(), model?: string): PoolAccount | undefined {
  const candidates = allCandidates(pool)
  // Start scanning at the cursor, keyed on the full candidate order so
  // parallel requests spread across accounts.
  const healthy = candidates.filter((a) => {
    const until = modelLimitUntil(a, model)
    return !until || until <= now
  })
  if (healthy.length === 0) return undefined
  const pick = healthy[rrCursor % healthy.length] ?? healthy[0]
  rrCursor = (rrCursor + 1) % Math.max(1, candidates.length * 2)
  return pick
}

function markAccountLimited(
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

function describeLimits(pool: PoolFile): string {
  const limited = pool.accounts.filter((a) => a.limitedUntil && a.limitedUntil > Date.now())
  if (limited.length === 0) return ""
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}→${new Date(a.limitedUntil!).toISOString()}`).join(", ")}.`
}

// --- Transparent same-request 429 + 401 failover ---
//
// OpenCode's AI SDK performs the HTTPS call with the apiKey the loader
// returned. When Cline answers 429 we swap in the next healthy account and
// replay the request, so one exhausted daily quota doesn't fail the turn.
// The same router handles 401/403 auth rejections: it refreshes the dead
// account once in place and replays, else quarantines it (NEEDS-RELOGIN)
// and retries the SAME request on the next healthy account.

const FETCH_PATCH_KEY = "__cline_free_fetch_router__"

function installFetchRouter(pool: PoolFile, log: Logger): void {
  const g = globalThis as Record<string | symbol, unknown>
  if (g[FETCH_PATCH_KEY]) return
  g[FETCH_PATCH_KEY] = true
  const origFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
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
        const acc = accountId ? pool.accounts.find((a) => a.id === accountId) : undefined
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
      if (earliest && t) {
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

// --- OpenCode plugin ---

const ClineFreePlugin: Plugin = async ({ client }) => {
  const log: Logger = (level, message, extra) => {
    void client.app
      .log({ body: { service: "cline-free", level, message, ...(extra ? { extra } : {}) } })
      .catch(() => {})
  }

  // Account pool: single source of truth for rotation. Seeded from the
  // pool file; env keys + native OpenCode auth merge in per request.
  const pool = await loadPoolFile()
  {
    const pruned = pruneLimits(pool)
    const deduped = dedupePool(pool)
    if (pruned || deduped) void savePoolFile(pool).catch(() => {})
    if (deduped) log("info", `cline-free: removed duplicate login(s) — ${pool.accounts.length} unique account(s) left`)
  }
  installFetchRouter(pool, log)

  // Fetch once at startup so /models shows the current rotation.
  // Falls back to FALLBACK_FREE offline (still usable until Cline rotates).
  const free = await fetchFreeModels()
  const models: Record<string, ReturnType<typeof modelConfig>> = {}
  for (const entry of free) models[entry.id] = modelConfig(entry)

  await client.app.log({
    body: {
      service: "cline-free",
      level: "info",
      message: `Loaded ${free.length} Cline free models`,
      extra: { models: free.map((m) => m.id) },
    },
  }).catch(() => {})
  const seeded = allCandidates(pool).length
  if (seeded > 0) {
    log("info", `cline-free: ${pool.accounts.length} stored account(s) + env merged → ${seeded} rotation candidate(s)`, {
      accounts: pool.accounts.map((a) => ({ id: a.id, label: a.label, source: a.source })),
    })
  }

  return {
    config: async (config: any) => {
      // NOTE: we inject via the `config` hook (not `provider.models`)
      // because OpenCode currently skips `provider.models` for providers
      // outside the models.dev catalog. Config injection works today.
      config.provider ??= {}
      const existing = config.provider[PROVIDER_ID] ?? {}
      const existingModels = existing.models ?? {}
      config.provider[PROVIDER_ID] = {
        name: "Cline Free",
        npm: "@ai-sdk/openai-compatible",
        ...existing,
        options: {
          ...(existing.options ?? {}),
          baseURL: existing.options?.baseURL ?? CHAT_BASE_URL,
          headers: {
            Accept: "application/json",
            "HTTP-Referer": "https://cline.bot",
            "X-Title": "OpenCode",
            ...(existing.options?.headers ?? {}),
          },
        },
        // User-declared models win; we only add missing free ids.
        models: { ...models, ...existingModels },
      }
    },

    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth: () => Promise<any>, provider: any) => {
        const baseHeaders = { "X-CLIENT-TYPE": "opencode" }
        if (pruneLimits(pool) || dedupePool(pool)) void savePoolFile(pool).catch(() => {})
        const auth = await getAuth().catch(() => undefined)

        // Merge the native single Auth into the pool (update in place when
        // the same Cline user logs in again, append only for new users) so
        // repeated `/connect` calls accumulate UNIQUE accounts.
        if (auth?.type === "api" && typeof auth.key === "string" && auth.key.trim()) {
          const snapshot = JSON.stringify(pool.accounts)
          upsertApiAccount(pool, String(auth.key), undefined)
          if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {})
        } else if (auth?.type === "oauth" && typeof auth.access === "string") {
          const snapshot = JSON.stringify(pool.accounts)
          const acc = upsertOAuthAccount(
            pool,
            { access: String(auth.access), refresh: String(auth.refresh ?? ""), expires: Number(auth.expires ?? 0) },
            typeof auth.accountId === "string" ? auth.accountId : undefined,
          )
          // Backfill a friendly label once per new account.
          if ((!acc.label || acc.label === auth.accountId) && isGenericLabel(acc.label)) {
            const knownEmail = normalizeEmailLabel(typeof auth.accountId === "string" ? auth.accountId : undefined) ?? payloadEmail(String(auth.access))
            if (knownEmail) {
              acc.label = knownEmail
              void savePoolFile(pool).catch(() => {})
            } else {
              void fetchUserEmail(String(auth.access)).then((email) => {
                if (email) {
                  acc.label = email
                  void savePoolFile(pool).catch(() => {})
                }
              })
            }
          }
          if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {})
        }

        let picked = selectAccount(pool, Date.now())
        if (!picked && pool.accounts.some((a) => a.authFailedAt)) {
          // No healthy account, but quarantined ones exist: give the
          // recovery probes a chance before reporting exhaustion (lazy, so
          // the hot path never pays probe latency).
          await probeQuarantinedAccounts(pool, log)
          picked = selectAccount(pool, Date.now())
        }
        if (!picked) {
          const candidates = allCandidates(pool)
          if (candidates.length === 0) return {}
          // Every account is cooling down: hand the request to the fetch
          // router with the earliest-reset account — it selects per model
          // (accounts limited on THIS model still block, others qualify),
          // so a 429 on glm doesn't block muse.
          const earliest = [...candidates].sort((a, b) => (b.limitedUntil ?? 0) - (a.limitedUntil ?? 0))[0]
          const t = tokenOf(earliest)
          if (!t) return {}
          log("warn", `cline-free: all accounts cooling down — next reset ${new Date(earliest.limitedUntil ?? Date.now()).toISOString()}${describeLimits(pool)}`)
          return { apiKey: withWorkOSPrefix(t), baseURL: CHAT_BASE_URL, headers: baseHeaders }
        }

        // Refresh the picked oauth account if it is about to expire.
        // Single-flight + persisted: concurrent requests share one refresh,
        // so rotation on the server never sees a replayed refresh token.
        const useFallback = (exceptId: string) => {
          const fb = selectAccount(pool, Date.now())
          const ft = fb ? tokenOf(fb) : undefined
          if (fb && ft && fb.id !== exceptId) {
            pool.activeId = fb.id
            fb.lastUsed = Date.now()
            void savePoolFile(pool).catch(() => {})
            return { apiKey: withWorkOSPrefix(ft), baseURL: CHAT_BASE_URL, headers: baseHeaders }
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
          // No usable fallback: continue with the quarantined token below so
          // the caller sees the real server response instead of nothing.
        } else if (needsRefresh) {
          try {
            await refreshAccount(pool, picked, log)
            // Keep the native single-auth entry fresh only when it belongs
            // to the same Cline user we just refreshed (identity, not token
            // equality — the token just rotated).
            const t = tokenOf(picked)
            if (auth?.type === "oauth" && typeof auth.access === "string" && t && sameAccount(auth.access, t)) {
              await provider
                ?.update?.({
                  access: stripWorkOSPrefix(t),
                  refresh: picked.refresh,
                  expires: picked.expires,
                })
                .catch(() => {})
            }
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
        if (!token) return {}
        pool.activeId = picked.id
        picked.lastUsed = Date.now()
        return { apiKey: withWorkOSPrefix(token), baseURL: CHAT_BASE_URL, headers: baseHeaders }
      },
      methods: [
        {
          type: "oauth",
          label: "Cline account (free models, recommended)",
          async authorize() {
            const device = await startDeviceAuth()
            return {
              url: device.verificationUriComplete ?? device.verificationUri,
              instructions:
                `Open the URL (code ${device.userCode} is pre-filled). ` +
                `Already logged into Cline in this browser? Just click Confirm/Approve — no password needed. ` +
                `Otherwise log in with Google/GitHub/Microsoft, then approve. ` +
                `Then wait — OpenCode completes login automatically.`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const workos = await pollDeviceAuth(
                    device.deviceCode,
                    device.expiresInSeconds,
                    device.intervalSeconds,
                  )
                  const creds = await registerWorkOSTokens(workos)
                  const email = await fetchUserEmail(creds.access)
                  const acc = upsertOAuthAccount(pool, creds, email, "oauth")
                  if (email) acc.label = email
                  void savePoolFile(pool).catch(() => {})
                  log("info", `cline-free: added account ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id })
                  return { type: "success" as const, ...creds }
                } catch (e) {
                  log("warn", `cline-free: device authorization failed: ${e instanceof Error ? e.message : String(e)}`)
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Reuse Cline CLI login (this machine, 1 confirm)",
          async authorize() {
            const session = await readClineCliSession()
            if (!session) {
              throw new Error(
                "No Cline CLI login found on this machine (~/.cline/data/settings/providers.json). " +
                  "Run `cline auth` first, or pick another method.",
              )
            }
            const who = session.email ? ` for ${session.email}` : ""
            return {
              url: "https://app.cline.bot/dashboard",
              instructions:
                `Found an existing Cline CLI login${who}. ` +
                `Confirm to connect it to OpenCode — no browser code needed.`,
              method: "auto" as const,
              callback: async () => {
                try {
                  let { access, refresh, expires } = session
                  if (!(await validateClineToken(access)) && refresh) {
                    try {
                      const next = await refreshClineToken(refresh, { label: session.email ?? "cli-import", log })
                      access = next.access
                      refresh = next.refresh
                      expires = next.expires
                    } catch (e) {
                      log("warn", `cline-free: CLI-imported token refresh failed: ${e instanceof Error ? e.message : String(e)}`)
                      return { type: "failed" as const }
                    }
                    if (!(await validateClineToken(access))) {
                      return { type: "failed" as const }
                    }
                  } else if (!(await validateClineToken(access))) {
                    return { type: "failed" as const }
                  }
                  // Update in place on same-user re-login, append only
                  // for new users (quota is per Cline user).
                  const acc = upsertOAuthAccount(pool, { access, refresh, expires }, session.email, "cli")
                  if (session.email) acc.label = session.email
                  void savePoolFile(pool).catch(() => {})
                  log("info", `cline-free: added CLI-imported account ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id })
                  return { type: "success" as const, access, refresh, expires }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Cline token (manual)",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Paste your Cline token (workos:... or raw access token):",
              placeholder: "workos:...",
            },
          ],
          async authorize(inputs?: Record<string, string>) {
            const key = inputs?.key?.trim()
            if (!key) return { type: "failed" as const }
            // Quick validation before storing.
            try {
              const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
                headers: { Authorization: `Bearer ${withWorkOSPrefix(key)}`, Accept: "application/json" },
              })
              if (!res.ok) return { type: "failed" as const }
            } catch {
              return { type: "failed" as const }
            }
            const email = await fetchUserEmail(key)
            const acc = upsertApiAccount(pool, key, email)
            if (email) acc.label = email
            void savePoolFile(pool).catch(() => {})
            log("info", `cline-free: added manual token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id })
            return { type: "success" as const, key }
          },
        },
      ],
    },

    tool: {
      cline_free_status: tool({
        description:
          "Show Cline Free account pool status: stored accounts, env accounts, which is active, and 429 cooldowns.",
        args: {},
        async execute() {
          pruneLimits(pool)
          if (dedupePool(pool)) void savePoolFile(pool).catch(() => {})
          const candidates = allCandidates(pool)
          const now = Date.now()
          // List STORED accounts (not just rotation candidates) so
          // quarantined entries stay visible with their NEEDS-RELOGIN flag.
          const lines = pool.accounts.map((a) => {
            const t = tokenOf(a)
            const now2 = Date.now()
            const modelCd = a.modelLimits
              ? Object.entries(a.modelLimits)
                  .filter(([, until]) => until > now2)
                  .map(([m, until]) => `${m}→${new Date(until).toISOString().slice(5, 16)}Z`)
                  .sort()
                  .join(", ")
              : ""
            const anyLimited = a.limitedUntil && a.limitedUntil > now2
            const quarantined = !!a.authFailedAt
            const flags = [
              a.id === pool.activeId ? "active" : "",
              modelCd || anyLimited ? "COOLDOWN" : "",
              modelCd,
              quarantined ? `NEEDS-RELOGIN${a.authFailedReason ? ` (${a.authFailedReason.slice(0, 80)})` : ""}` : "",
              a.source,
            ]
              .filter(Boolean)
              .join(" | ")
            return `- ${a.label ?? a.id} [${a.id}] (${flags}) token ${t ? maskToken(t) : "?"}` +
              (a.expires ? ` expires ${new Date(a.expires).toISOString()}` : "")
          })
          const envCount = candidates.filter((a) => a.id.startsWith("env-")).length
          const qCount = pool.accounts.filter((a) => a.authFailedAt).length
          const header = `cline-free pool: ${pool.accounts.length} stored${qCount ? ` (${qCount} need re-login)` : ""} + ${envCount} env → ${candidates.length} rotation candidate(s). File: ${poolFilePath()}`
          return lines.length > 0 ? `${header}\n${lines.join("\n")}` : `${header}\n(no accounts — run /connect and pick cline-free)`
        },
      }),

      cline_free_remove: tool({
        description: "Remove a stored Cline Free account from the rotation pool by id (see cline_free_status). Env accounts cannot be removed here — unset the env var instead.",
        args: {
          id: tool.schema.string().describe("Account id (acc_...) from cline_free_status"),
        },
        async execute(args) {
          const idx = pool.accounts.findIndex((a) => a.id === args.id)
          if (idx === -1) return `No stored account with id ${args.id}.`
          const [removed] = pool.accounts.splice(idx, 1)
          if (pool.activeId === args.id) delete pool.activeId
          await savePoolFile(pool).catch(() => {})
          log("info", `cline-free: removed account ${removed.label ?? removed.id}`, { accountId: args.id })
          return `Removed ${removed.label ?? removed.id} (${pool.accounts.length} stored left).`
        },
      }),

      cline_free_add_token: tool({
        description: "Validate and add a Cline token (workos:... or raw) to the rotation pool.",
        args: {
          token: tool.schema.string().describe("Cline token (workos:... or raw access token)"),
          label: tool.schema.string().optional().describe("Friendly label (defaults to account email)"),
        },
        async execute(args) {
          const key = args.token?.trim()
          if (!key) return "No token provided."
          try {
            const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
              headers: { Authorization: `Bearer ${withWorkOSPrefix(key)}`, Accept: "application/json" },
            })
            if (!res.ok) return `Token rejected by Cline (HTTP ${res.status}). Not added.`
          } catch (e) {
            return `Could not reach Cline: ${e instanceof Error ? e.message : String(e)}. Not added.`
          }
          const email = await fetchUserEmail(key)
          const acc = upsertApiAccount(pool, key, args.label?.trim() || email)
          if (args.label?.trim()) acc.label = args.label.trim()
          else if (email) acc.label = email
          await savePoolFile(pool).catch(() => {})
          log("info", `cline-free: added token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id })
          return `Added ${acc.label ?? acc.id} [${acc.id}] (${pool.accounts.length} stored total).`
        },
      }),
    },
  }
}

// Test seam (no runtime effect on the plugin): lets harness scripts
// exercise the auth plumbing with a mocked transport.
export const __clineFreeTest = {
  TerminalAuthError,
  TransientAuthError,
  classifyHttpFailure,
  parseOAuthErrorCode,
  refreshClineTokenOnce,
  refreshClineToken,
  refreshAccount,
  quarantineAccount,
  withTransientRetries,
  fetchWithTimeout,
  withWorkOSPrefix,
  dedupePool,
  loadPoolFile,
  savePoolFile,
}

export default {
  id: "cline-free",
  server: ClineFreePlugin,
}
