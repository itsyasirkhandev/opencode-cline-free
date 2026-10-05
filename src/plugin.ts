import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { pollDeviceAuth, readClineCliSession, refreshClineToken, registerWorkOSTokens, startDeviceAuth, validateClineToken } from "./auth.ts"
import { API_BASE, CHAT_BASE_URL, PROVIDER_ID, REFRESH_BUFFER_MS } from "./constants.ts"
import { TerminalAuthError, fetchWithTimeout, sleep, withWorkOSPrefix } from "./http.ts"
import { loadFreeModels } from "./modelList.ts"
import { type AutoMeta, type FreeEntry, modelConfig } from "./models.ts"
import { type Logger, allCandidates, dedupePool, describeLimits, fetchUserEmail, isGenericLabel, loadPoolFile, maskToken, normalizeEmailLabel, payloadEmail, poolFilePath, probeQuarantinedAccounts, pruneLimits, quarantineAccount, refreshAccount, sameAccount, savePoolFile, selectAccount, stripWorkOSPrefix, tokenOf, upsertApiAccount, upsertOAuthAccount } from "./pool.ts"
import { createRoutedFetch } from "./router.ts"

// --- OpenCode plugin ---

export const ClineFreePlugin: Plugin = async ({ client }) => {
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
  const routedFetch = createRoutedFetch(pool, log)

  // Startup list: last good live list from disk (refreshed in the
  // background), else the live endpoint, else the bundled fallback.
  const { entries: free, meta, source, refreshed } = await loadFreeModels(log)
  const buildModels = (list: FreeEntry[], autoMeta: Record<string, AutoMeta>) => {
    const out: Record<string, ReturnType<typeof modelConfig>> = {}
    for (const entry of list) out[entry.id] = modelConfig(entry, autoMeta[entry.id])
    return out
  }

  await client.app.log({
    body: {
      service: "cline-free",
      level: "info",
      message: `Loaded ${free.length} Cline models (${source})`,
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
      // Prefer the background refresh when it lands quickly.
      const latest = (await Promise.race([refreshed, sleep(1500).then(() => undefined)])) ?? { entries: free, meta }
      const models = buildModels(latest.entries, latest.meta)
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
            // Cline surface headers (mirrors official clients — see
            // cline/cline#13593). The gateway serves the native free
            // models only to requests carrying this identity; without
            // them it answers 403 "only available via Cline product
            // surfaces". Verified 2026-09-21 against the live API.
            "HTTP-Referer": "https://cline.bot",
            "X-Title": "Cline",
            "User-Agent": "Cline/4.1.16",
            "X-CLIENT-TYPE": "VSCode Extension",
            "X-CLIENT-VERSION": "4.1.16",
            "X-CORE-VERSION": "4.1.16",
            "X-PLATFORM": "vscode",
            "X-PLATFORM-VERSION": "4.1.16",
            "X-IS-MULTIROOT": "false",
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
          return { apiKey: withWorkOSPrefix(t), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch }
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
            return { apiKey: withWorkOSPrefix(ft), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch }
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
        return { apiKey: withWorkOSPrefix(token), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch }
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
