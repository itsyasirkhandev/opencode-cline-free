// Runtime-agnostic tool logic. Adapters only wrap these in their host's
// tool format (V1 `tool()` helper, V2 `ctx.tool.transform`).
import { API_BASE } from "./constants.ts"
import { fetchWithTimeout, withWorkOSPrefix } from "./http.ts"
import {
  type Logger,
  type PoolFile,
  allCandidates,
  dedupePool,
  fetchUserEmail,
  forgetRemoval,
  hasNoCredits,
  maskToken,
  poolFilePath,
  pruneLimits,
  rememberRemoval,
  savePoolFile,
  tokenOf,
  upsertApiAccount,
} from "./pool.ts"

export const TOOL_DESCRIPTIONS = {
  status: "Show Cline Free account pool status: stored accounts, env accounts, which is active, 429 cooldowns, and accounts out of Cline credits.",
  remove:
    "Remove a stored Cline Free account from the rotation pool by id (see cline_free_status). Env accounts cannot be removed here — unset the env var instead.",
  addToken: "Validate and add a Cline token (workos:... or raw) to the rotation pool.",
} as const

export function poolStatusText(pool: PoolFile): string {
  pruneLimits(pool)
  if (dedupePool(pool)) void savePoolFile(pool).catch(() => {})
  const candidates = allCandidates(pool)
  // List STORED accounts (not just rotation candidates) so quarantined
  // entries stay visible with their NEEDS-RELOGIN flag.
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
      hasNoCredits(pool, a.id) ? "NO-CREDITS (paid models skipped until restart)" : "",
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
}

export async function removeAccount(pool: PoolFile, id: string, log: Logger): Promise<string> {
  const idx = pool.accounts.findIndex((a) => a.id === id)
  if (idx === -1) return `No stored account with id ${id}.`
  const [removed] = pool.accounts.splice(idx, 1)
  if (pool.activeId === id) delete pool.activeId
  // Remember it, or the active /connect connection (merged before every
  // request) and the host's token refresh would add it straight back.
  const token = tokenOf(removed)
  if (token) rememberRemoval(pool, token)
  await savePoolFile(pool).catch(() => {})
  log("info", `cline-free: removed account ${removed.label ?? removed.id}`, { accountId: id })
  return (
    `Removed ${removed.label ?? removed.id} (${pool.accounts.length} stored left). ` +
    `If it is also connected in /connect, disconnect it there too; until then the plugin ignores that connection. ` +
    `Logging in again with the same account brings it back.`
  )
}

export async function addToken(pool: PoolFile, token: string | undefined, label: string | undefined, log: Logger): Promise<string> {
  const key = token?.trim()
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
  forgetRemoval(pool, key)
  const acc = upsertApiAccount(pool, key, label?.trim() || email)
  if (label?.trim()) acc.label = label.trim()
  else if (email) acc.label = email
  await savePoolFile(pool).catch(() => {})
  log("info", `cline-free: added token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id })
  return `Added ${acc.label ?? acc.id} [${acc.id}] (${pool.accounts.length} stored total).`
}
