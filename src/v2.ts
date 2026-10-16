import type { Model, Plugin, Provider } from "@opencode/plugin"
import { pollDeviceAuth, readClineCliSession, refreshClineToken, registerWorkOSTokens, startDeviceAuth, validateClineToken } from "./core/auth.ts"
import { CHAT_BASE_URL, CLINE_HEADERS, PROVIDER_ID } from "./core/constants.ts"
import { withWorkOSPrefix } from "./core/http.ts"
import { loadFreeModels } from "./core/modelList.ts"
import { type AutoMeta, type FreeEntry, modelConfig } from "./core/models.ts"
import { type Logger, accountEmail, allCandidates, dedupePool, fetchUserEmail, forgetRemoval, isRoutableUrl, loadPoolFile, modelOfRequest, payloadEmail, pruneLimits, sameAccount, savePoolFile, tokenOf, upsertOAuthAccount } from "./core/pool.ts"
import { type ConnectionCredential, mergeConnectionCredential, refreshViaPool, resolveActiveToken, tidyPool } from "./core/account.ts"
import { TOOL_DESCRIPTIONS, addToken, poolStatusText, removeAccount } from "./core/tools.ts"
import { recoverResponse } from "./core/router.ts"

// --- OpenCode V2 adapter ---
// Thin glue between the V2 plugin context and the runtime-agnostic core in
// ./core. Only `import type` from @opencode/plugin: the bundle has no
// runtime dependency on the host package.

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type ProviderInput = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0]["add"] extends (input: infer I) => void ? I : never
type IntegrationEditor = Parameters<Parameters<Context["integration"]["transform"]>[0]>[0]
type MethodRegistration = Parameters<IntegrationEditor["method"]["update"]>[0]
type OAuthCredential = Extract<MethodRegistration, { refresh?: unknown }> extends { refresh?: (c: infer C) => unknown } ? C : never
type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0]
type ToolInfo = Parameters<ToolEditor["add"]>[0]
type USDPerMillion = Model.Cost["input"]

const providerID = PROVIDER_ID as Provider.ID
const DEVICE_METHOD = "device"
const CLI_METHOD = "cli"

const log: Logger = (level, message, extra) => {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.info(line)
}

/** Map the core model description onto V2's `Model.Info`. */
export function toModelInfo(entry: FreeEntry, auto?: AutoMeta): Model.Info {
  const config = modelConfig(entry, auto)
  const id = entry.id as Model.ID
  const usd = (n: number) => n as USDPerMillion
  return {
    id,
    modelID: id,
    providerID,
    name: config.name,
    capabilities: { tools: config.tool_call, input: config.modalities.input, output: config.modalities.output },
    ...(config.options ? { settings: { reasoningEffort: config.options.reasoningEffort } } : {}),
    variants: Object.entries(config.variants ?? {}).map(([level, options]) => ({
      id: level as Model.VariantID,
      settings: { reasoningEffort: options.reasoningEffort },
    })),
    time: { released: 0 },
    cost: [
      {
        input: usd(config.cost.input),
        output: usd(config.cost.output),
        cache: { read: usd(config.cost.cache_read), write: usd(config.cost.cache_write) },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: config.limit.context, output: config.limit.output },
  }
}

export function providerInput(entries: FreeEntry[], meta: Record<string, AutoMeta>): ProviderInput {
  return {
    info: {
      id: providerID,
      integrationID: PROVIDER_ID as NonNullable<Provider.Info["integrationID"]>,
      name: "Cline Free",
      // Always listed: the account pool (not V2's single credential) decides
      // which Cline account a request uses.
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: CHAT_BASE_URL },
      headers: { ...CLINE_HEADERS },
    },
    models: entries.map((entry) => toModelInfo(entry, meta[entry.id])),
  }
}

/** OpenCode's "Connect an integration" dialog lists every account label
 * next to the integration name, so full emails crowd out "Cline Free".
 * Use the email's local part, capped at 12 characters. */
export function accountLabel(email: string | undefined) {
  const local = email?.split("@")[0]
  if (!local) return undefined
  return local.length > 12 ? `${local.slice(0, 11)}…` : local
}

const oauthCredential = (methodID: string, creds: { access: string; refresh: string; expires: number }, email?: string): OAuthCredential =>
  ({
    type: "oauth",
    methodID,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    ...(email ? { metadata: { email } } : {}),
  }) as OAuthCredential

/** Email for a connection: from the token when it carries one, else the
 * email saved at login (`metadata.email`), else the pool account's label. */
export function credentialEmail(
  credential: { access: string; metadata?: Record<string, unknown> },
  pool?: { accounts: Parameters<typeof accountEmail>[0][] },
): string | undefined {
  const saved = credential.metadata?.email
  const owner = pool?.accounts.find((a) => {
    const t = tokenOf(a)
    return !!t && sameAccount(t, credential.access)
  })
  return (
    payloadEmail(credential.access) ??
    (typeof saved === "string" && saved.includes("@") ? saved : undefined) ??
    (owner ? accountEmail(owner) : undefined)
  )
}

const objectSchema = (properties: Record<string, { type: "string"; description: string }>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as unknown as ToolInfo["input"]

const text = (input: unknown, key: string): string | undefined => {
  const value = (input as Record<string, unknown> | undefined)?.[key]
  return typeof value === "string" ? value : undefined
}

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  let disposed = false

  // Account pool: single source of truth for rotation. Same file as the V1
  // releases, so existing accounts carry over without logging in again.
  const pool = await loadPoolFile()
  {
    const pruned = pruneLimits(pool)
    const deduped = dedupePool(pool)
    if (pruned || deduped) void savePoolFile(pool).catch(() => {})
    if (deduped) log("info", `cline-free: removed duplicate login(s) — ${pool.accounts.length} unique account(s) left`)
  }
  const seeded = allCandidates(pool).length
  if (seeded > 0) log("info", `cline-free: ${pool.accounts.length} stored account(s) + env merged → ${seeded} rotation candidate(s)`)

  // Startup list: last good live list from disk, else the live endpoint,
  // else the bundled fallback. A background refresh swaps it in later.
  const loaded = await loadFreeModels(log)
  const models = { entries: loaded.entries, meta: loaded.meta }
  log("info", `cline-free: loaded ${models.entries.length} Cline models (${loaded.source})`)

  await ctx.provider.transform((editor) => {
    editor.add(providerInput(models.entries, models.meta))
  })
  void loaded.refreshed.then(async (latest) => {
    if (!latest || disposed) return
    models.entries = latest.entries
    models.meta = latest.meta
    await ctx.provider.reload()
  }).catch(() => {})

  // --- Login methods (integration `cline-free`) ---
  // OpenCode gives authorize() no cancel signal. A new device login
  // supersedes the previous one: its polling stops and, if it still
  // completes, the account is not added to the pool.
  let deviceLogin: AbortController | undefined
  await ctx.integration.transform((editor) => {
    editor.update(PROVIDER_ID, (integration) => {
      integration.name = "Cline Free"
    })
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: DEVICE_METHOD, type: "oauth", label: "Cline account (free models, recommended)" },
      authorize: async () => {
        deviceLogin?.abort()
        const attempt = new AbortController()
        deviceLogin = attempt
        const device = await startDeviceAuth()
        const callback = (async () => {
          const workos = await pollDeviceAuth(device.deviceCode, device.expiresInSeconds, device.intervalSeconds, attempt.signal)
          if (attempt.signal.aborted || disposed) throw new Error("device login was superseded by a newer login attempt")
          const creds = await registerWorkOSTokens(workos)
          const email = await fetchUserEmail(creds.access)
          if (attempt.signal.aborted || disposed) throw new Error("device login was superseded by a newer login attempt")
          forgetRemoval(pool, creds.access)
          const acc = upsertOAuthAccount(pool, creds, email, "oauth")
          if (email) acc.label = email
          void savePoolFile(pool).catch(() => {})
          log("info", `cline-free: added account ${acc.label ?? acc.id} (${pool.accounts.length} total)`)
          return oauthCredential(DEVICE_METHOD, creds, email)
        })()
        callback.catch((e) => log("warn", `cline-free: device authorization failed: ${e instanceof Error ? e.message : String(e)}`))
        return {
          url: device.verificationUriComplete ?? device.verificationUri,
          instructions:
            `Open the URL (code ${device.userCode} is pre-filled). ` +
            `Already logged into Cline in this browser? Just click Confirm/Approve — no password needed. ` +
            `Otherwise log in with Google/GitHub/Microsoft, then approve. ` +
            `Then wait — OpenCode completes login automatically.`,
          expiresAt: Date.now() + device.expiresInSeconds * 1000,
          mode: "auto",
          callback,
        }
      },
      refresh: async (credential) => {
        const creds = await refreshViaPool(pool, credential, log)
        // Keep the email saved at login: refreshed tokens may not carry one.
        return oauthCredential(credential.methodID, creds, credentialEmail({ ...credential, access: creds.access }, pool))
      },
      label: (credential) => accountLabel(credentialEmail(credential, pool)),
    })
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: CLI_METHOD, type: "oauth", label: "Reuse Cline CLI login (this machine, 1 confirm)" },
      authorize: async () => {
        const session = await readClineCliSession()
        if (!session) {
          throw new Error(
            "No Cline CLI login found on this machine (~/.cline/data/settings/providers.json). " +
              "Run `cline auth` first, or pick another method.",
          )
        }
        const callback = (async () => {
          let { access, refresh, expires } = session
          if (!(await validateClineToken(access))) {
            if (!refresh) throw new Error("Cline CLI session expired and has no refresh token. Run `cline auth` again.")
            const next = await refreshClineToken(refresh, { label: session.email ?? "cli-import", log })
            access = next.access
            refresh = next.refresh
            expires = next.expires
            if (!(await validateClineToken(access))) throw new Error("Cline rejected the refreshed CLI session.")
          }
          // Update in place on same-user re-login, append only for new users
          // (quota is per Cline user).
          forgetRemoval(pool, access)
          const acc = upsertOAuthAccount(pool, { access, refresh, expires }, session.email, "cli")
          if (session.email) acc.label = session.email
          void savePoolFile(pool).catch(() => {})
          log("info", `cline-free: added CLI-imported account ${acc.label ?? acc.id} (${pool.accounts.length} total)`)
          return oauthCredential(CLI_METHOD, { access, refresh, expires }, session.email)
        })()
        callback.catch((e) => log("warn", `cline-free: CLI login import failed: ${e instanceof Error ? e.message : String(e)}`))
        const who = session.email ? ` for ${session.email}` : ""
        return {
          url: "https://app.cline.bot/dashboard",
          instructions: `Found an existing Cline CLI login${who}. Connecting it to OpenCode — no browser code needed.`,
          mode: "auto",
          callback,
        }
      },
      refresh: async (credential) => {
        const creds = await refreshViaPool(pool, credential, log)
        // Keep the email saved at login: refreshed tokens may not carry one.
        return oauthCredential(credential.methodID, creds, credentialEmail({ ...credential, access: creds.access }, pool))
      },
      label: (credential) => accountLabel(credentialEmail(credential, pool)),
    })
    // Stored by OpenCode as-is; merged into the pool on the next request.
    // Use the cline_free_add_token tool to validate a token up front.
    editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "Cline token (manual)" } })
  })

  // --- Requests: pick the pool account, fail over on 401/403/429 ---
  await ctx.session.hook(
    "http.request",
    async (event) => {
      // Provider scoping is not a URL trust boundary. Reject before reading
      // credentials or mutating the request/pool, just like the core router.
      if (!isRoutableUrl(event.request.url)) return
      tidyPool(pool)
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      if (connection) {
        const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
        mergeConnectionCredential(pool, credential as ConnectionCredential)
      }
      // Model of the request so the pick skips accounts capped on it.
      const body = await Promise.resolve()
        .then(() => event.request.clone().arrayBuffer())
        .catch(() => null)
      const model = modelOfRequest(event.request.url, body)
      // Same session + model → same account, so its prompt cache stays warm.
      const token = await resolveActiveToken(pool, log, { model, sessionID: event.sessionID })
      if (token) event.request.headers.set("authorization", `Bearer ${withWorkOSPrefix(token)}`)
      event.request.headers.set("X-Task-ID", event.sessionID)
    },
    { providerID: PROVIDER_ID },
  )
  await ctx.session.hook(
    "http.response",
    async (event) => {
      event.response = await recoverResponse(pool, log, event.request, event.response, undefined, { sessionID: event.sessionID })
    },
    { providerID: PROVIDER_ID },
  )

  // --- Tools ---
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "cline_free_status",
      description: TOOL_DESCRIPTIONS.status,
      input: objectSchema({}, []),
      execute: async () => ({ content: poolStatusText(pool) }),
    })
    editor.add({
      name: "cline_free_remove",
      description: TOOL_DESCRIPTIONS.remove,
      input: objectSchema({ id: { type: "string", description: "Account id (acc_...) from cline_free_status" } }, ["id"]),
      execute: async (input) => ({ content: await removeAccount(pool, text(input, "id") ?? "", log) }),
    })
    editor.add({
      name: "cline_free_add_token",
      description: TOOL_DESCRIPTIONS.addToken,
      input: objectSchema(
        {
          token: { type: "string", description: "Cline token (workos:... or raw access token)" },
          label: { type: "string", description: "Friendly label (defaults to account email)" },
        },
        ["token"],
      ),
      execute: async (input) => ({ content: await addToken(pool, text(input, "token"), text(input, "label"), log) }),
    })
  })

  return () => {
    disposed = true
  }
}
