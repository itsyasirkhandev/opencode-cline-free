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
  return t.toLowerCase().startsWith(WORKOS_PREFIX) ? t : `${WORKOS_PREFIX}${t}`
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

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  if (!text) return `${res.status} ${res.statusText}`
  try {
    const j = JSON.parse(text) as { error_description?: string; message?: string; error?: string }
    return j.error_description ?? j.message ?? j.error ?? text
  } catch {
    return text
  }
}

async function startDeviceAuth() {
  const res = await fetch(`${WORKOS_API}/user_management/authorize/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
  })
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
    throw new Error(`Cline device authorization failed: ${data.error_description ?? data.error ?? res.statusText}`)
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
  const deadline = Date.now() + expiresInSeconds * 1000
  let interval = Math.max(1, intervalSeconds)
  while (Date.now() <= deadline) {
    const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }),
    })
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
      interval += 1
      await new Promise((r) => setTimeout(r, interval * 1000))
      continue
    }
    throw new Error(`Cline device authorization failed: ${data.error_description ?? data.error ?? res.statusText}`)
  }
  throw new Error("Cline device authorization timed out — run /connect again and approve the browser prompt.")
}

async function registerWorkOSTokens(tokens: { accessToken: string; refreshToken: string }) {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(tokens),
  })
  if (!res.ok) throw new Error(`Cline token registration failed: ${await readError(res)}`)
  const payload = (await res.json()) as {
    success?: boolean
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string }
  }
  const data = payload.data
  if (!payload.success || !data?.accessToken || !data?.expiresAt) {
    throw new Error("Invalid token response from Cline")
  }
  const expires = Date.parse(data.expiresAt)
  if (Number.isNaN(expires)) throw new Error(`Invalid token expiration from Cline: ${data.expiresAt}`)
  return {
    access: data.accessToken,
    refresh: data.refreshToken ?? tokens.refreshToken,
    expires: expires - REFRESH_BUFFER_MS,
  }
}

async function refreshClineToken(refresh: string) {  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh, grantType: "refresh_token" }),
  })
  if (!res.ok) throw new Error(`Cline token refresh failed: ${await readError(res)}`)
  const payload = (await res.json()) as {
    success?: boolean
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string }
  }
  const data = payload.data
  if (!payload.success || !data?.accessToken || !data?.expiresAt) {
    throw new Error("Invalid refresh response from Cline")
  }
  const expires = Date.parse(data.expiresAt)
  if (Number.isNaN(expires)) throw new Error("Invalid token expiration from Cline")
  return { access: data.accessToken, refresh: data.refreshToken ?? refresh, expires: expires - REFRESH_BUFFER_MS }
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
    const res = await fetch(`${API_BASE}/api/v1/users/me`, {
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
  lastUsed?: number
  lastError?: string
}

type PoolFile = { version: 1; activeId?: string; accounts: PoolAccount[] }

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

function isRoutableUrl(url: string): boolean {
  return (
    url.startsWith(API_BASE) &&
    (url.includes("/chat/completions") || url.includes("/completions"))
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
  const { mkdir, writeFile, chmod } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const file = poolFilePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(pool, null, 2), { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
}

function pruneLimits(pool: PoolFile, now = Date.now()): boolean {
  let changed = false
  for (const a of pool.accounts) {
    if (a.limitedUntil && a.limitedUntil <= now) {
      delete a.limitedUntil
      delete a.lastError
      changed = true
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
  const bestByUser = new Map<string, PoolAccount>()
  const bestByEmail = new Map<string, PoolAccount>()
  for (const a of pool.accounts) {
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
  if (bestByUser.size === 0 && bestByEmail.size === 0) return false
  const keep = new Set<string>()
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
    const res = await fetch(`${API_BASE}/api/v1/users/me`, {
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
    delete acc.limitedUntil
    delete acc.lastError
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
    delete acc.limitedUntil
    delete acc.lastError
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

// In-memory rotation cursor (round-robin across healthy accounts).
let rrCursor = 0

/** Next healthy account in round-robin order; undefined when all limited. */
function selectAccount(pool: PoolFile, now = Date.now()): PoolAccount | undefined {
  const candidates = allCandidates(pool)
  // Start scanning at the cursor, keyed on the full candidate order so
  // parallel requests spread across accounts.
  const healthy = candidates.filter((a) => !(a.limitedUntil && a.limitedUntil > now))
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
): void {
  const acc = pool.accounts.find((a) => a.id === id)
  const until = Date.now() + (retryAfterMs ?? nextUtcMidnightMs() - Date.now())
  const name = acc?.label ?? id
  if (acc) {
    acc.limitedUntil = until
    acc.lastError = `429${detail ? `: ${detail}` : ""}`
  }
  log("warn", `cline-free: account ${name} hit 429 — cooling down until ${new Date(until).toISOString()}${detail ? ` (${detail})` : ""}`, {
    accountId: id,
    limitedUntil: until,
  })
  void savePoolFile(pool).catch(() => {})
}

function describeLimits(pool: PoolFile): string {
  const limited = pool.accounts.filter((a) => a.limitedUntil && a.limitedUntil > Date.now())
  if (limited.length === 0) return ""
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}→${new Date(a.limitedUntil!).toISOString()}`).join(", ")}.`
}

// --- Transparent same-request 429 failover ---
//
// OpenCode's AI SDK performs the HTTPS call with the apiKey the loader
// returned. When Cline answers 429 we swap in the next healthy account and
// replay the request, so one exhausted daily quota doesn't fail the turn.

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
    pruneLimits(pool, now)

    // First attempt keeps the loader-chosen identity; rotation only kicks
    // in after a 429, so the round-robin cursor advances once per request.
    const first =
      incomingToken && findByToken(pool, incomingToken)
        ? { token: incomingToken, accountId: findByToken(pool, incomingToken)!.id }
        : undefined

    const tried = new Set<string>()
    let lastRes: Response | undefined
    // Bound attempts: first identity + every other healthy candidate once.
    const maxAttempts = allCandidates(pool).length + 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let token: string
      let accountId: string | undefined
      if (attempt === 0 && first) {
        ;({ token, accountId } = first)
      } else {
        if (attempt === 0 && !first && incomingToken) {
          // Unknown identity (manual header override): try it once as-is.
          token = incomingToken
        } else {
          const next = selectAccount(pool, Date.now())
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
      if (res.status !== 429) {
        if (accountId) {
          pool.activeId = accountId
          const acc = pool.accounts.find((a) => a.id === accountId)
          if (acc) {
            acc.lastUsed = Date.now()
            void savePoolFile(pool).catch(() => {})
          }
        }
        if (attempt > 0) log("info", `cline-free: request recovered on ${pool.accounts.find((a) => a.id === accountId)?.label ?? "fallback account"} after 429 (attempt ${attempt + 1})`)
        return res
      }

      // 429: note the snippet, park this account, try the next one.
      let snippet = ""
      try {
        snippet = ((await res.clone().text().catch(() => "")) || "").slice(0, 300)
      } catch {
        snippet = ""
      }
      try {
        await res.arrayBuffer().catch(() => {})
      } catch {
        /* ignore */
      }
      const retryAfter = parseRetryAfterMs(res)
      const detail = snippet.replace(/\s+/g, " ").trim().slice(0, 160) || undefined
      if (accountId && pool.accounts.some((a) => a.id === accountId)) {
        markAccountLimited(pool, accountId, retryAfter, log, detail)
      } else {
        log("warn", `cline-free: 429 on untracked identity (${maskToken(token)})${detail ? ` — ${detail}` : ""}`)
        break
      }
      lastRes = res
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

        const picked = selectAccount(pool, Date.now())
        if (!picked) {
          const candidates = allCandidates(pool)
          if (candidates.length === 0) return {}
          // Every account is cooling down: report when the first recovers
          // instead of failing silently. The fetch router replays on the
          // earliest account so the caller still sees the real 429 body.
          const earliest = [...candidates].sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0))[0]
          const t = tokenOf(earliest)
          if (!t) return {}
          log("warn", `cline-free: all accounts cooling down — next reset ${new Date(earliest.limitedUntil ?? Date.now()).toISOString()}${describeLimits(pool)}`)
          return { apiKey: withWorkOSPrefix(t), baseURL: CHAT_BASE_URL, headers: baseHeaders }
        }

        // Refresh the picked oauth account if it is about to expire.
        if (picked.access && picked.refresh && typeof picked.expires === "number" && picked.expires - Date.now() < REFRESH_BUFFER_MS) {
          try {
            const next = await refreshClineToken(picked.refresh)
            picked.access = next.access
            picked.refresh = next.refresh
            picked.expires = next.expires
            delete picked.lastError
            void savePoolFile(pool).catch(() => {})
            // Keep the native single-auth entry fresh only when it is the
            // same account we just refreshed.
            if (auth?.type === "oauth" && typeof auth.access === "string" && sameToken(auth.access, next.access)) {
              await provider?.update?.({ access: next.access, refresh: next.refresh, expires: next.expires }).catch(() => {})
            }
          } catch (e) {
            log("warn", `cline-free: token refresh failed for ${picked.label ?? picked.id}: ${e instanceof Error ? e.message : String(e)} — trying next account`, { accountId: picked.id })
            picked.lastError = "refresh failed"
            const fallback = selectAccount(pool, Date.now())
            const ft = fallback ? tokenOf(fallback) : undefined
            if (fallback && ft && fallback.id !== picked.id) {
              pool.activeId = fallback.id
              fallback.lastUsed = Date.now()
              void savePoolFile(pool).catch(() => {})
              return { apiKey: withWorkOSPrefix(ft), baseURL: CHAT_BASE_URL, headers: baseHeaders }
            }
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
                      const next = await refreshClineToken(refresh)
                      access = next.access
                      refresh = next.refresh
                      expires = next.expires
                    } catch {
                      return { type: "failed" as const }
                    }
                    if (!(await validateClineToken(access))) {
                      return { type: "failed" as const }
                    }
                  } else if (!(await validateClineToken(access))) {
                    return { type: "failed" as const }
                  }
                  // Append to the pool (never replace): repeated logins
                  // accumulate rotation candidates.
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
              const res = await fetch(`${API_BASE}/api/v1/users/me`, {
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
          const lines = candidates.map((a) => {
            const t = tokenOf(a)
            const limited = a.limitedUntil && a.limitedUntil > now
            const flags = [
              a.id === pool.activeId ? "active" : "",
              limited ? `COOLDOWN→${new Date(a.limitedUntil!).toISOString()}` : "",
              a.source,
            ]
              .filter(Boolean)
              .join(" | ")
            return `- ${a.label ?? a.id} [${a.id}] (${flags}) token ${t ? maskToken(t) : "?"}` +
              (a.expires ? ` expires ${new Date(a.expires).toISOString()}` : "")
          })
          const header = `cline-free pool: ${candidates.length} candidate(s) (${pool.accounts.length} stored + ${candidates.length - pool.accounts.length} env). File: ${poolFilePath()}`
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
            const res = await fetch(`${API_BASE}/api/v1/users/me`, {
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

export default {
  id: "cline-free",
  server: ClineFreePlugin,
}
