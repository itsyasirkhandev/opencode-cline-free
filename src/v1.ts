import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { pollDeviceAuth, readClineCliSession, refreshClineToken, registerWorkOSTokens, startDeviceAuth, validateClineToken } from "./core/auth.ts"
import { API_BASE, CHAT_BASE_URL, PROVIDER_ID } from "./core/constants.ts"
import { fetchWithTimeout, sleep, withWorkOSPrefix } from "./core/http.ts"
import { loadFreeModels } from "./core/modelList.ts"
import { type AutoMeta, type FreeEntry, modelConfig } from "./core/models.ts"
import { type Logger, allCandidates, dedupePool, fetchUserEmail, loadPoolFile, pruneLimits, sameAccount, savePoolFile, stripWorkOSPrefix, tokenOf, upsertApiAccount, upsertOAuthAccount } from "./core/pool.ts"
import { mergeNativeAuth, resolveActiveToken, tidyPool } from "./core/account.ts"
import { TOOL_DESCRIPTIONS, addToken, poolStatusText, removeAccount } from "./core/tools.ts"
import { createRoutedFetch } from "./core/router.ts"

// --- OpenCode V1 adapter ---
// Thin glue between the V1 hook API and the runtime-agnostic core in
// ./core. Keep OpenCode-version-specific code here only.

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
        tidyPool(pool)
        const auth = await getAuth().catch(() => undefined)
        mergeNativeAuth(pool, auth)

        const token = await resolveActiveToken(pool, log, {
          // Keep the native single-auth entry fresh only when it belongs to
          // the same Cline user we just refreshed (identity, not token
          // equality — the token just rotated).
          onRefreshed: async (picked) => {
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
          },
        })
        if (!token) return {}
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
        description: TOOL_DESCRIPTIONS.status,
        args: {},
        async execute() {
          return poolStatusText(pool)
        },
      }),

      cline_free_remove: tool({
        description: TOOL_DESCRIPTIONS.remove,
        args: {
          id: tool.schema.string().describe("Account id (acc_...) from cline_free_status"),
        },
        async execute(args) {
          return removeAccount(pool, args.id, log)
        },
      }),

      cline_free_add_token: tool({
        description: TOOL_DESCRIPTIONS.addToken,
        args: {
          token: tool.schema.string().describe("Cline token (workos:... or raw access token)"),
          label: tool.schema.string().optional().describe("Friendly label (defaults to account email)"),
        },
        async execute(args) {
          return addToken(pool, args.token, args.label, log)
        },
      }),
    },
  }
}
