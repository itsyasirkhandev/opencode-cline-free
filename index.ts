import type { Plugin } from "@opencode-ai/plugin"

/**
 * opencode-cline-free
 *
 * Exposes Cline's rotating free models inside OpenCode through your
 * Cline account (same account/quota you see in Cline VSCode/CLI).
 *
 * Live list: GET https://api.cline.bot/api/v1/ai/cline/recommended-models
 * As of 2026-09-13 the `free` array is:
 * - cline-free/muse-spark-1.3-contributor
 * - deepseek/deepseek-v4-flash
 * - z-ai/glm-5.3-flash
 * - cline-free/solar-pro4
 * - cline-free/longcat-2.0
 * - poolside/laguna-s-2.1:free
 * (glm-5.3-flash + laguna overlap with Zen, the other 4 are Cline-only free.)
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
    id: "cline-free/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    description:
      "Meta's multimodal reasoning model for experimentation and agentic coding workflows.",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Fast and efficient with 1M context window.",
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
    id: "cline-free/longcat-2.0",
    name: "LongCat 2.0",
    description: "Trillion-parameter model built for agentic coding.",
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1 (free)",
    description: "Latest coding agent model from Poolside.",
  },
]

// Best-effort context/output limits (OpenCode only uses these for
// budgeting/truncation; the server remains authoritative).
const LIMITS: Record<string, { context: number; output: number }> = {
  "cline-free/muse-spark-1.3-contributor": { context: 256_000, output: 32_000 },
  "deepseek/deepseek-v4-flash": { context: 1_048_576, output: 32_768 },
  "z-ai/glm-5.3-flash": { context: 200_000, output: 64_000 },
  "cline-free/solar-pro4": { context: 128_000, output: 32_000 },
  "cline-free/longcat-2.0": { context: 256_000, output: 64_000 },
  "poolside/laguna-s-2.1:free": { context: 256_000, output: 32_768 },
}
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 }

// Valid reasoning efforts, probed live against
// https://api.cline.bot/api/v1/chat/completions (2026-09-13):
// - every free model accepts low/medium/high/max EXCEPT
//   muse-spark-1.3 (accepts minimal/low/medium/high/xhigh;
//   `max` → HTTP 500 invalid_request_error from Meta via OpenRouter)
// - glm officially documents low/high/max only (medium is accepted but
//   mapped to max by the companion reasoning hook)
// - laguna exposes only off/max (max is default) → no variants
const VARIANTS: Record<string, string[]> = {
  "cline-free/muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  "deepseek/deepseek-v4-flash": ["low", "medium", "high", "max"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "cline-free/solar-pro4": ["low", "medium", "high", "max"],
  "cline-free/longcat-2.0": ["low", "medium", "high", "max"],
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
  const variants: Record<string, { reasoningEffort: string }> = {}
  for (const level of levels) variants[level] = { reasoningEffort: level }
  return {
    name: displayName(entry),
    limit: { context: limit.context, output: limit.output },
    modalities: { input: ["text"], output: ["text"] },
    tool_call: true,
    reasoning: true,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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

// --- OpenCode plugin ---

const ClineFreePlugin: Plugin = async ({ client }) => {
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
        const envKey =
          process.env.CLINE_API_KEY ?? process.env.CLINE_FREE_API_KEY ?? process.env[`${PROVIDER_ID.toUpperCase().replace(/-/g, "_")}_API_KEY`]
        const auth = await getAuth().catch(() => undefined)
        if (!auth && envKey) return { apiKey: withWorkOSPrefix(envKey) }
        if (!auth) return {}
        if (auth.type === "api") {
          return { apiKey: withWorkOSPrefix(String(auth.key)) }
        }
        if (auth.type === "oauth") {
          let { access, refresh, expires } = auth
          if (typeof expires === "number" && expires - Date.now() < REFRESH_BUFFER_MS) {
            try {
              const next = await refreshClineToken(refresh)
              access = next.access
              refresh = next.refresh
              expires = next.expires
              await provider?.update?.({ access, refresh, expires }).catch(() => {})
            } catch (e) {
              await client.app.log({
                body: {
                  service: "cline-free",
                  level: "warn",
                  message: `Cline token refresh failed: ${e instanceof Error ? e.message : String(e)}`,
                },
              }).catch(() => {})
            }
          }
          return {
            apiKey: withWorkOSPrefix(String(access)),
            baseURL: CHAT_BASE_URL,
            headers: { "X-CLIENT-TYPE": "opencode" },
          }
        }
        return {}
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
            return { type: "success" as const, key }
          },
        },
      ],
    },
  }
}

export default {
  id: "cline-free",
  server: ClineFreePlugin,
}
