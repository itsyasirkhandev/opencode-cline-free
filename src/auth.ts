import { API_BASE, REFRESH_BUFFER_MS, WORKOS_API, WORKOS_CLIENT_ID } from "./constants.ts"
import { TerminalAuthError, TransientAuthError, classifyHttpFailure, fetchWithTimeout, isAbortError, parseOAuthErrorCode, withTransientRetries, withWorkOSPrefix } from "./http.ts"
import { type Logger } from "./pool.ts"

export async function startDeviceAuth() {
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

export async function pollDeviceAuth(deviceCode: string, expiresInSeconds: number, intervalSeconds: number) {
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

export async function registerWorkOSTokens(tokens: { accessToken: string; refreshToken: string }) {
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

export type RefreshResult = { access: string; refresh: string; expires: number }

/** Single refresh attempt. Throws TerminalAuthError (re-login required,
 * do not retry) or TransientAuthError (same refresh token is safe to
 * retry — rotation grace windows tolerate this). */
export async function refreshClineTokenOnce(
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
export async function refreshClineToken(
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

export type ClineCliAuth = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number | string
  metadata?: { userInfo?: { email?: string } }
}

export type ClineProvidersFile = {
  providers?: Record<string, { settings?: { auth?: ClineCliAuth } }>
}

export function clineProvidersFileCandidates(): string[] {
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

export async function readClineCliSession(): Promise<
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

export async function validateClineToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${withWorkOSPrefix(accessToken)}`, Accept: "application/json" },
    })
    return res.ok
  } catch {
    return false
  }
}
