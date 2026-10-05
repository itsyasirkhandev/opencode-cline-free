// src/plugin.ts
import { tool } from "@opencode-ai/plugin";

// src/constants.ts
var PROVIDER_ID = "cline-free";
var API_BASE = "https://api.cline.bot";
var CHAT_BASE_URL = `${API_BASE}/api/v1`;
var RECOMMENDED_URL = `${API_BASE}/api/v1/ai/cline/recommended-models`;
var WORKOS_API = "https://api.workos.com";
var WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
var WORKOS_PREFIX = "workos:";
var REFRESH_BUFFER_MS = 5 * 60 * 1e3;
var ACCOUNTS_FILE_NAME = "cline-free-accounts.json";
var DAY_MS = 24 * 60 * 60 * 1e3;

// src/http.ts
function withWorkOSPrefix(token) {
  const t = token.trim();
  if (t.toLowerCase().startsWith(WORKOS_PREFIX)) return t;
  if (!t.startsWith("eyJ")) return t;
  return `${WORKOS_PREFIX}${t}`;
}
var AUTH_TIMEOUT_MS = 15e3;
var TRANSIENT_MAX_ATTEMPTS = 4;
var TRANSIENT_BACKOFF_MS = [300, 800, 2e3];
var TerminalAuthError = class extends Error {
  kind = "terminal";
};
var TransientAuthError = class extends Error {
  kind = "transient";
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isAbortError(e) {
  return typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError" || typeof e === "object" && e !== null && e.name === "AbortError";
}
async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = AUTH_TIMEOUT_MS, signal: outer, ...rest } = init;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) {
      clearTimeout(timer);
      throw outer.reason ?? new DOMException("Aborted", "AbortError");
    }
    outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new TransientAuthError(`request timed out after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
function parseOAuthErrorCode(body) {
  if (typeof body === "object" && body !== null) {
    const code = body.error;
    if (typeof code === "string" && code) return code.toLowerCase();
  }
  return void 0;
}
function classifyHttpFailure(status, code, where, detail) {
  const extra = detail ? `: ${detail}` : "";
  if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
    return new TerminalAuthError(`${where}: ${code}${extra} \u2014 re-login required (/connect \u2192 cline-free)`);
  }
  if (status === 408 || status === 429 || status !== void 0 && status >= 500) {
    return new TransientAuthError(`${where}: HTTP ${status}${code ? ` (${code})` : ""}${extra}`);
  }
  if (status !== void 0 && status >= 400) {
    return new TerminalAuthError(`${where}: HTTP ${status}${code ? ` (${code})` : ""}${extra} \u2014 retrying is unlikely to help`);
  }
  return new TransientAuthError(`${where}${extra}`);
}
async function withTransientRetries(fn, opts = {}) {
  const attempts = opts.attempts ?? TRANSIENT_MAX_ATTEMPTS;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TerminalAuthError) throw e;
      last = e;
      if (attempt === attempts - 1) break;
      const wait = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)] + Math.random() * 250;
      opts.log?.(
        "warn",
        `cline-free: attempt ${attempt + 1}/${attempts} failed${opts.label ? ` for ${opts.label}` : ""} (${e instanceof Error ? e.message : String(e)}) \u2014 retrying in ${Math.round(wait)}ms`
      );
      await sleep(wait);
    }
  }
  if (last instanceof TerminalAuthError) throw last;
  throw last instanceof Error ? last : new TransientAuthError(`operation failed: ${String(last)}`);
}

// src/auth.ts
async function startDeviceAuth() {
  const res = await withTransientRetries(
    () => fetchWithTimeout(`${WORKOS_API}/user_management/authorize/device`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID })
    }),
    { attempts: 2, label: "device authorization" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
    throw classifyHttpFailure(
      res.ok ? void 0 : res.status,
      parseOAuthErrorCode(data),
      "Cline device authorization",
      data.error_description ?? (typeof data.error === "string" ? data.error : void 0) ?? res.statusText
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresInSeconds: data.expires_in ?? 300,
    intervalSeconds: data.interval ?? 5
  };
}
async function pollDeviceAuth(deviceCode, expiresInSeconds, intervalSeconds) {
  const deadline = Date.now() + Math.max(30, expiresInSeconds - 10) * 1e3;
  let interval = Math.max(1, intervalSeconds);
  while (Date.now() <= deadline) {
    let res;
    try {
      res = await fetchWithTimeout(`${WORKOS_API}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: WORKOS_CLIENT_ID
        })
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      await new Promise((r) => setTimeout(r, interval * 1e3));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token && data.refresh_token) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    }
    if (data.error === "authorization_pending") {
      await new Promise((r) => setTimeout(r, interval * 1e3));
      continue;
    }
    if (data.error === "slow_down") {
      interval += 5;
      await new Promise((r) => setTimeout(r, interval * 1e3));
      continue;
    }
    if (data.error === "access_denied") {
      throw new TerminalAuthError("Cline device authorization denied in the browser \u2014 run /connect again and approve the prompt.");
    }
    if (data.error === "expired_token") {
      throw new TerminalAuthError("Cline device code expired before approval \u2014 run /connect again for a fresh code.");
    }
    throw new TerminalAuthError(`Cline device authorization failed: ${data.error_description ?? data.error ?? res.statusText}`);
  }
  throw new Error("Cline device authorization timed out \u2014 run /connect again and approve the browser prompt.");
}
async function registerWorkOSTokens(tokens) {
  return withTransientRetries(
    async () => {
      const res = await fetchWithTimeout(`${API_BASE}/api/v1/auth/register`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(tokens)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let code;
        let detail = `${res.status} ${res.statusText}`;
        if (text) {
          try {
            const j = JSON.parse(text);
            code = typeof j.error === "string" ? j.error.toLowerCase() : void 0;
            detail = (j.error_description ?? j.message ?? j.error ?? text).slice(0, 200);
          } catch {
            detail = text.slice(0, 200);
          }
        }
        throw classifyHttpFailure(res.status, code, "Cline token registration", detail);
      }
      const payload = await res.json();
      const data = payload.data;
      if (!payload.success || !data?.accessToken || !data?.expiresAt) {
        throw new TransientAuthError("Invalid token response from Cline");
      }
      const expires = Date.parse(data.expiresAt);
      if (Number.isNaN(expires)) throw new TransientAuthError(`Invalid token expiration from Cline: ${data.expiresAt}`);
      return {
        access: data.accessToken,
        refresh: data.refreshToken ?? tokens.refreshToken,
        expires: expires - REFRESH_BUFFER_MS
      };
    },
    { attempts: 3, label: "token registration" }
  );
}
async function refreshClineTokenOnce(refresh, post = (url, init) => fetchWithTimeout(url, init)) {
  let res;
  try {
    res = await post(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh, grantType: "refresh_token" })
    });
  } catch (e) {
    if (e instanceof TerminalAuthError) throw e;
    if (isAbortError(e)) throw e;
    throw new TransientAuthError(`Cline token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code;
    let detail = `${res.status} ${res.statusText}`;
    if (text) {
      try {
        const j = JSON.parse(text);
        code = typeof j.error === "string" ? j.error.toLowerCase() : void 0;
        detail = (j.error_description ?? j.message ?? j.error ?? text).slice(0, 200);
      } catch {
        detail = text.slice(0, 200);
      }
    }
    throw classifyHttpFailure(res.status, code, "Cline token refresh", detail);
  }
  const payload = await res.json();
  const data = payload.data;
  if (!payload.success || !data?.accessToken || !data?.expiresAt) {
    throw new TransientAuthError("Invalid refresh response from Cline");
  }
  const expires = Date.parse(data.expiresAt);
  if (Number.isNaN(expires)) throw new TransientAuthError("Invalid token expiration from Cline");
  return { access: data.accessToken, refresh: data.refreshToken ?? refresh, expires: expires - REFRESH_BUFFER_MS };
}
async function refreshClineToken(refresh, opts = {}) {
  return withTransientRetries(() => refreshClineTokenOnce(refresh, opts.post), {
    label: opts.label ? `token refresh for ${opts.label}` : "token refresh",
    log: opts.log
  });
}
function clineProvidersFileCandidates() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [];
  const dataDir = process.env.CLINE_DATA_DIR;
  if (dataDir) candidates.push(`${dataDir}/settings/providers.json`);
  const clineDir = process.env.CLINE_DIR;
  if (clineDir) {
    candidates.push(`${clineDir}/data/settings/providers.json`);
    candidates.push(`${clineDir}/settings/providers.json`);
  }
  if (home) {
    candidates.push(`${home}/.cline/data/settings/providers.json`);
    candidates.push(`${home}/.cline/settings/providers.json`);
  }
  return candidates;
}
async function readClineCliSession() {
  const { readFile } = await import("node:fs/promises");
  for (const file of clineProvidersFileCandidates()) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const data = JSON.parse(raw);
      const auth = data.providers?.cline?.settings?.auth;
      const accessToken = auth?.accessToken?.trim();
      if (!accessToken) continue;
      const rawExpires = auth?.expiresAt;
      const expiresAt = typeof rawExpires === "number" ? rawExpires < 1e12 ? rawExpires * 1e3 : rawExpires : typeof rawExpires === "string" ? Date.parse(rawExpires) : NaN;
      return {
        access: accessToken.replace(/^workos:/i, ""),
        refresh: auth?.refreshToken?.trim() ?? "",
        expires: Number.isNaN(expiresAt) ? 0 : expiresAt - REFRESH_BUFFER_MS,
        email: auth?.metadata?.userInfo?.email
      };
    } catch {
      continue;
    }
  }
  return void 0;
}
async function validateClineToken(accessToken) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${withWorkOSPrefix(accessToken)}`, Accept: "application/json" }
    });
    return res.ok;
  } catch {
    return false;
  }
}

// src/models.ts
var DEFAULT_COST = { input: 0, output: 0, cache_read: 0 };
var DEFAULT_LIMIT = { context: 2e5, output: 32e3 };
var DEFAULT_INPUT = ["text"];
var DEFAULT_VARIANTS = ["low", "medium", "high"];
var FULL = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
var NO_NONE = ["minimal", "low", "medium", "high", "xhigh", "max"];
var MODELS = {
  // --- Current free rotation (checked 2026-10-05) ---
  "stealth/space-bunny-alpha": {
    name: "Space Bunny Alpha",
    description: "Anonymous large model with blazing-fast inference, strong coding, native multimodal input, and 1M context.",
    status: "free",
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 1e6, output: 524288 },
    input: ["text", "image", "video"],
    variants: NO_NONE
  },
  "cline-free/mimo-v2.6-flash": {
    name: "MiMo V2.6 Flash",
    description: "Xiaomi MiMo 2.6 Flash \u2014 309B MoE (15B active), hybrid attention, multimodal.",
    status: "free",
    cost: { input: 0.14, output: 0.28, cache_read: 28e-4 },
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image", "video", "audio"],
    variants: FULL
  },
  "cline-free/muse-spark-1.3-contributor": {
    name: "Muse Spark 1.3 Contributor",
    description: "Meta's multimodal reasoning model for experimentation and agentic coding workflows.",
    status: "free",
    cost: { input: 0.1, output: 0.2, cache_read: 2e-3 },
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image", "video", "audio", "pdf"],
    variants: ["minimal", "low", "medium", "high", "xhigh"]
  },
  // --- Paid (always registered, bills Cline credits — verified 2026-09-24:
  // the account balance drops by `creditsUsed`, the free rotation records 0) ---
  "z-ai/glm-5.3-flash": {
    name: "GLM 5.3 Flash",
    description: "Z-AI GLM-5.3 Flash \u2014 bills Cline credits (not free).",
    status: "paid",
    cost: { input: 0.075, output: 0.25, cache_read: 0.015 },
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image", "video"],
    variants: ["low", "high", "max"]
  },
  // --- Rotated out (kept so metadata is right if they return) ---
  // Left the free list on 2026-10-05; Cline now lists it at paid rates.
  "cline-free/deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    description: "Sparse MoE (CED architecture) with native image understanding and 1M context window.",
    status: "stale",
    cost: { input: 0.3, output: 1.2, cache_read: 6e-3 },
    limit: { context: 1e6, output: 384e3 },
    input: ["text", "image"],
    variants: FULL
  },
  "stealth/pixel-canary": {
    name: "Pixel Canary",
    description: "Anonymous large model with strong coding capabilities.",
    status: "stale",
    variants: NO_NONE
  },
  "cline-free/gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    description: "Google's most intelligent Flash model.",
    status: "stale",
    cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
    limit: { context: 1048576, output: 65536 },
    input: ["text", "image", "video", "audio", "pdf"],
    variants: ["low", "medium", "high"]
  },
  "stealth/union-alpha": {
    name: "Union Alpha",
    status: "stale",
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 262144, output: 131072 },
    input: ["text", "image"],
    variants: ["low", "medium", "high", "xhigh"],
    // Server default is medium; set explicitly so no-variant runs stay there.
    defaultEffort: "medium"
  },
  "deepseek/deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    status: "stale",
    cost: { input: 0.3, output: 1.2, cache_read: 6e-3 },
    limit: { context: 1e6, output: 384e3 },
    input: ["text", "image"],
    variants: FULL
  },
  "deepseek/deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    status: "stale",
    cost: { input: 0.14, output: 0.28, cache_read: 28e-4 },
    limit: { context: 1048576, output: 384e3 },
    input: ["text"],
    variants: ["low", "medium", "high", "max"]
  },
  "cline-free/solar-pro4": {
    name: "Solar Pro 4",
    status: "stale",
    cost: { input: 0.03, output: 0.12, cache_read: 6e-3 },
    limit: { context: 524288, output: 131072 },
    input: ["text"],
    variants: ["low", "medium", "high", "max"]
  },
  "poolside/laguna-s-2.1:free": {
    name: "Laguna S 2.1",
    status: "stale",
    cost: { input: 0.1, output: 0.2, cache_read: 0.01 },
    limit: { context: 256e3, output: 32e3 },
    input: ["text"],
    variants: []
  }
};
function toEntry(id, spec) {
  return { id, name: spec.name, description: spec.description, ...spec.status === "paid" ? { paid: true } : {} };
}
var FALLBACK_FREE = Object.entries(MODELS).filter(([, s]) => s.status === "free").map(([id, s]) => toEntry(id, s));
var EXTRA_MODELS = Object.entries(MODELS).filter(([, s]) => s.status === "paid").map(([id, s]) => toEntry(id, s));
function isPaidModel(id) {
  return !!id && MODELS[id]?.status === "paid";
}
function withExtraModels(entries) {
  const ids = new Set(entries.map((e) => e.id));
  return [...entries, ...EXTRA_MODELS.filter((e) => !ids.has(e.id))];
}
function displayName(entry) {
  const base = (entry.name?.trim() || entry.id).trim();
  if (entry.paid || isPaidModel(entry.id)) return base.toLowerCase().includes("paid") ? base : `${base} (paid)`;
  return base.toLowerCase().includes("free") ? base : `${base} (free)`;
}
function modelConfig(entry, auto) {
  const spec = MODELS[entry.id];
  const limit = spec?.limit ?? auto?.limit ?? DEFAULT_LIMIT;
  const levels = spec?.variants ?? (auto?.reasoning === false ? [] : DEFAULT_VARIANTS);
  const cost = spec?.cost ?? auto?.cost ?? DEFAULT_COST;
  const variants = {};
  for (const level of levels) variants[level] = { reasoningEffort: level };
  return {
    name: displayName(entry),
    limit: { context: limit.context, output: limit.output },
    modalities: { input: spec?.input ?? auto?.input ?? DEFAULT_INPUT, output: ["text"] },
    tool_call: true,
    reasoning: true,
    cost: { input: cost.input, output: cost.output, cache_read: cost.cache_read, cache_write: 0 },
    ...spec?.defaultEffort ? { options: { reasoningEffort: spec.defaultEffort } } : {},
    ...levels.length > 0 ? { variants } : {}
  };
}

// src/pool.ts
function modelOfRequest(url, body) {
  if (!body || !url.includes("/chat/completions")) return void 0;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    const m = parsed?.model;
    return typeof m === "string" && m.trim() ? m.trim() : void 0;
  } catch {
    return void 0;
  }
}
function modelLimitUntil(acc, model) {
  if (!model || !acc.modelLimits) return void 0;
  const until = acc.modelLimits[model];
  return typeof until === "number" ? until : void 0;
}
function poolFilePath() {
  const override = process.env.CLINE_FREE_ACCOUNTS_FILE?.trim();
  if (override) return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const dataDir = process.env.XDG_DATA_HOME?.trim() || (home ? `${home}/.local/share/opencode` : "");
  if (dataDir) return `${dataDir}/${ACCOUNTS_FILE_NAME}`;
  return `./${ACCOUNTS_FILE_NAME}`;
}
function stripWorkOSPrefix(token) {
  return token.trim().replace(/^workos:/i, "");
}
function sameToken(a, b) {
  return stripWorkOSPrefix(a) === stripWorkOSPrefix(b);
}
function sameAccount(a, b) {
  const ka = clineUserKey(a);
  const kb = clineUserKey(b);
  if (ka && kb) return ka === kb;
  return sameToken(a, b);
}
function b64UrlDecodeToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const g = globalThis;
  if (g.Buffer) return g.Buffer.from(padded, "base64").toString("utf8");
  if (typeof g.atob === "function") {
    const bin = g.atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  throw new Error("no base64 decoder available");
}
function decodeJwtPayload(token) {
  try {
    const raw = stripWorkOSPrefix(token).trim();
    const parts = raw.split(".");
    if (parts.length < 2 || !parts[1]) return void 0;
    return JSON.parse(b64UrlDecodeToString(parts[1]));
  } catch {
    return void 0;
  }
}
function clineUserKey(token) {
  const p = decodeJwtPayload(token);
  if (!p) return void 0;
  const ext = typeof p.external_id === "string" ? p.external_id.trim() : "";
  if (ext) return `ext:${ext}`;
  const sub = typeof p.sub === "string" ? p.sub.trim() : "";
  if (sub) return `sub:${sub}`;
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
  if (email.includes("@")) return `email:${email}`;
  return void 0;
}
function payloadEmail(token) {
  const p = decodeJwtPayload(token);
  const email = typeof p?.email === "string" ? p.email.trim().toLowerCase() : "";
  return email.includes("@") ? email : void 0;
}
function normalizeEmailLabel(label) {
  if (!label) return void 0;
  const t = label.trim().toLowerCase();
  return t.includes("@") ? t : void 0;
}
function accountEmail(a) {
  return normalizeEmailLabel(a.label) ?? (tokenOf(a) ? payloadEmail(tokenOf(a)) : void 0);
}
function freshnessOf(a) {
  return Math.max(a.expires ?? 0, a.lastUsed ?? 0, a.addedAt ?? 0);
}
function isGenericLabel(label) {
  if (!label) return true;
  const t = label.trim();
  if (!t) return true;
  if (t.includes("@")) return false;
  return /^(cline-\d+|token-…|token-|connect-token|account-\d+)$/i.test(t) || t.length <= 8;
}
function maskToken(token) {
  const t = stripWorkOSPrefix(token);
  if (t.length <= 10) return "\u2026";
  return `${t.slice(0, 4)}\u2026${t.slice(-4)}`;
}
function newAccountId() {
  return `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nextUtcMidnightMs(now = Date.now(), bufferMs = 5 * 60 * 1e3) {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() + bufferMs;
}
function parseRetryAfterMs(res) {
  const raw = res.headers?.get?.("retry-after");
  if (raw) {
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs >= 0 && secs <= 48 * 3600) return secs * 1e3;
    const date = Date.parse(raw.trim());
    if (!Number.isNaN(date)) {
      const delta = date - Date.now();
      if (delta > 0 && delta <= 48 * 3600 * 1e3) return delta;
    }
  }
  return void 0;
}
function parseRetryAfterFromBody(detail) {
  if (!detail) return void 0;
  const m = /try again in\s*(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?/i.exec(detail);
  if (!m) return void 0;
  const d = Number(m[1] ?? 0);
  const h = Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  const total = (d * 24 + h) * 36e5 + min * 6e4;
  if (total <= 0 || total > 48 * 36e5) return void 0;
  return total;
}
function isRoutableUrl(url) {
  return url.startsWith(API_BASE) && (url.includes("/chat/completions") || url.includes("/completions"));
}
function isAuthFailure(status, snippet) {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /unauthor|re-authenticate|reauthenticate|invalid_grant|invalid_token|expired|please .* (login|authenticate)/i.test(
    snippet
  );
}
async function loadPoolFile() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(poolFilePath(), "utf8");
    const data = JSON.parse(raw);
    const accounts = Array.isArray(data.accounts) ? data.accounts.filter(
      (a) => !!a && typeof a.id === "string" && (typeof a.access === "string" || typeof a.apiKey === "string")
    ) : [];
    return { version: 1, activeId: typeof data.activeId === "string" ? data.activeId : void 0, accounts };
  } catch {
    return { version: 1, accounts: [] };
  }
}
async function savePoolFile(pool) {
  const { mkdir, writeFile, chmod, rename, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const file = poolFilePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(pool, null, 2), { mode: 384 });
    await chmod(tmp, 384).catch(() => {
    });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw e;
  }
}
async function withFileLock(fn, opts = {}) {
  const { open, unlink, stat, utimes } = await import("node:fs/promises");
  const lock = `${poolFilePath()}.lock`;
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const staleMs = opts.staleMs ?? 15e3;
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lock, "wx", 384);
      await fh.writeFile(`${process.pid}`).catch(() => {
      });
      await fh.close().catch(() => {
      });
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          await unlink(lock).catch(() => {
          });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new TransientAuthError(`timed out waiting for pool lock (${lock})`);
      }
      await sleep(50 + Math.random() * 100);
    }
  }
  const beat = setInterval(() => {
    const now = /* @__PURE__ */ new Date();
    void utimes(lock, now, now).catch(() => {
    });
  }, Math.max(250, Math.floor(staleMs / 3)));
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await unlink(lock).catch(() => {
    });
  }
}
function pruneLimits(pool, now = Date.now()) {
  let changed = false;
  for (const a of pool.accounts) {
    if (a.limitedUntil && a.limitedUntil <= now) {
      delete a.limitedUntil;
      delete a.lastError;
      changed = true;
    }
    if (a.modelLimits) {
      for (const [m, until] of Object.entries(a.modelLimits)) {
        if (until <= now) {
          delete a.modelLimits[m];
          changed = true;
        }
      }
      if (Object.keys(a.modelLimits).length === 0) delete a.modelLimits;
    }
  }
  return changed;
}
function splitEnvList(value) {
  return value.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length >= 10);
}
function collectEnvKeys() {
  const out = [];
  const singles = [process.env.CLINE_API_KEY, process.env.CLINE_FREE_API_KEY];
  for (const s of singles) if (s?.trim()) out.push(s.trim());
  for (const list of [process.env.CLINE_API_KEYS, process.env.CLINE_FREE_API_KEYS]) {
    if (list) out.push(...splitEnvList(list));
  }
  for (let i = 2; i <= 10; i++) {
    for (const v of [process.env[`CLINE_API_KEY_${i}`], process.env[`CLINE_FREE_API_KEY_${i}`]]) {
      if (v?.trim()) out.push(v.trim());
    }
  }
  return [...new Set(out)];
}
function tokenOf(a) {
  return a.access ?? a.apiKey;
}
function allCandidates(pool) {
  const sorted = [...pool.accounts].sort((a, b) => freshnessOf(b) - freshnessOf(a));
  const seenToken = /* @__PURE__ */ new Set();
  const seenUser = /* @__PURE__ */ new Set();
  const out = [];
  for (const a of sorted) {
    const t = tokenOf(a);
    if (!t) continue;
    if (a.authFailedAt) continue;
    const tkey = stripWorkOSPrefix(t);
    if (seenToken.has(tkey)) continue;
    const ukey = clineUserKey(t) ?? (accountEmail(a) ? `email:${accountEmail(a)}` : void 0);
    if (ukey) {
      if (seenUser.has(ukey)) continue;
      seenUser.add(ukey);
    }
    seenToken.add(tkey);
    out.push(a);
  }
  const envKeys = collectEnvKeys();
  envKeys.forEach((key, i) => {
    const k = stripWorkOSPrefix(key);
    if (seenToken.has(k)) return;
    const ukey = clineUserKey(key) ?? (normalizeEmailLabel(key) ? `email:${normalizeEmailLabel(key)}` : void 0);
    if (ukey && seenUser.has(ukey)) return;
    if (ukey) seenUser.add(ukey);
    seenToken.add(k);
    const fp = `${k.slice(0, 4)}${k.slice(-4)}${k.length}`;
    out.push({
      id: `env-${fp}`,
      label: envKeys.length > 1 ? `env-${i + 1} (${maskToken(key)})` : `env (${maskToken(key)})`,
      apiKey: key.trim(),
      source: "env",
      addedAt: 0
    });
  });
  return out;
}
function dedupePool(pool) {
  const keepAlways = new Set(
    pool.accounts.filter((a) => a.apiKey && !a.access).map((a) => a.id)
  );
  const bestByUser = /* @__PURE__ */ new Map();
  const bestByEmail = /* @__PURE__ */ new Map();
  for (const a of pool.accounts) {
    if (keepAlways.has(a.id)) continue;
    const t = tokenOf(a);
    if (!t) continue;
    const ukey = clineUserKey(t);
    if (ukey) {
      const cur = bestByUser.get(ukey);
      if (!cur || freshnessOf(a) > freshnessOf(cur)) bestByUser.set(ukey, a);
      continue;
    }
    const email = accountEmail(a);
    if (email) {
      const cur = bestByEmail.get(email);
      if (!cur || freshnessOf(a) > freshnessOf(cur)) bestByEmail.set(email, a);
    }
  }
  if (bestByUser.size === 0 && bestByEmail.size === 0 && keepAlways.size === 0) return false;
  const keep = new Set(keepAlways);
  for (const a of bestByUser.values()) keep.add(a.id);
  for (const a of bestByEmail.values()) {
    const claimed = [...bestByUser.values()].some((u) => accountEmail(u) === a.label?.trim().toLowerCase() || accountEmail(u) === accountEmail(a));
    if (!claimed) keep.add(a.id);
  }
  for (const a of pool.accounts) {
    const t = tokenOf(a);
    if (!t) {
      keep.add(a.id);
      continue;
    }
    if (!clineUserKey(t) && !accountEmail(a)) keep.add(a.id);
  }
  if (keep.size === pool.accounts.length) return false;
  const kept = pool.accounts.filter((a) => keep.has(a.id));
  const removed = pool.accounts.filter((a) => !keep.has(a.id));
  pool.accounts = kept;
  if (pool.activeId && !keep.has(pool.activeId)) {
    const oldActive = removed.find((a) => a.id === pool.activeId);
    const oldToken = oldActive ? tokenOf(oldActive) : void 0;
    const siblingKey = oldToken ? clineUserKey(oldToken) : void 0;
    const sibling = siblingKey ? bestByUser.get(siblingKey) : void 0;
    pool.activeId = sibling?.id ?? kept[0]?.id;
    if (!pool.activeId) delete pool.activeId;
  }
  pool.activeId ??= kept[0]?.id;
  return true;
}
function findOAuthDuplicate(pool, access, label) {
  const key = stripWorkOSPrefix(access);
  const byToken = pool.accounts.find((a) => {
    const t = tokenOf(a);
    return !!t && stripWorkOSPrefix(t) === key;
  });
  if (byToken) return byToken;
  if (!decodeJwtPayload(key)) return void 0;
  const ukey = clineUserKey(access);
  if (ukey) {
    const byUser = pool.accounts.find((a) => {
      const t = tokenOf(a);
      return !!t && clineUserKey(t) === ukey;
    });
    if (byUser) return byUser;
  }
  const email = normalizeEmailLabel(label) ?? payloadEmail(access);
  if (email) {
    const byEmail = pool.accounts.find((a) => accountEmail(a) === email);
    if (byEmail) return byEmail;
  }
  return void 0;
}
function findByToken(pool, token) {
  const key = stripWorkOSPrefix(token);
  return pool.accounts.find((a) => {
    const t = tokenOf(a);
    return !!t && stripWorkOSPrefix(t) === key;
  }) ?? allCandidates(pool).find((a) => {
    const t = tokenOf(a);
    return !!t && stripWorkOSPrefix(t) === key;
  });
}
async function fetchUserEmail(accessToken) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${withWorkOSPrefix(accessToken)}`, Accept: "application/json" }
    });
    if (!res.ok) return void 0;
    const j = await res.json().catch(() => void 0);
    const email = j?.data?.email ?? j?.data?.user?.email ?? j?.email ?? j?.user?.email ?? j?.data?.userInfo?.email;
    return typeof email === "string" && email.includes("@") ? email : void 0;
  } catch {
    return void 0;
  }
}
function clearAuthHealth(acc) {
  delete acc.limitedUntil;
  delete acc.lastError;
  delete acc.authFailedAt;
  delete acc.authFailedReason;
  delete acc.lastProbeAt;
}
function upsertOAuthAccount(pool, creds, label, source = "oauth") {
  const acc = findOAuthDuplicate(pool, creds.access, label);
  if (acc) {
    acc.access = stripWorkOSPrefix(creds.access);
    acc.refresh = creds.refresh;
    acc.expires = creds.expires;
    const emailLabel = normalizeEmailLabel(label);
    if (emailLabel) acc.label = emailLabel;
    else if (isGenericLabel(acc.label)) {
      const fromToken = payloadEmail(creds.access);
      if (fromToken) acc.label = fromToken;
      else if (label?.trim()) acc.label = label.trim();
    }
    clearAuthHealth(acc);
    dedupePool(pool);
    pool.activeId ??= acc.id;
    return acc;
  }
  const emailFromToken = payloadEmail(creds.access);
  const fresh = {
    id: newAccountId(),
    label: normalizeEmailLabel(label) ?? emailFromToken ?? label?.trim() ?? `cline-${pool.accounts.length + 1}`,
    access: stripWorkOSPrefix(creds.access),
    refresh: creds.refresh,
    expires: creds.expires,
    source,
    addedAt: Date.now()
  };
  pool.accounts.push(fresh);
  dedupePool(pool);
  pool.activeId ??= fresh.id;
  return pool.accounts.find((a) => a.id === fresh.id) ?? fresh;
}
function upsertApiAccount(pool, key, label, source = "api") {
  const acc = findOAuthDuplicate(pool, key, label);
  if (acc) {
    if (acc.access) acc.access = stripWorkOSPrefix(key.trim());
    else acc.apiKey = key.trim();
    const emailLabel = normalizeEmailLabel(label);
    if (emailLabel) acc.label = emailLabel;
    else if (isGenericLabel(acc.label) && label?.trim()) acc.label = label.trim();
    clearAuthHealth(acc);
    dedupePool(pool);
    pool.activeId ??= acc.id;
    return acc;
  }
  const fresh = {
    id: newAccountId(),
    label: normalizeEmailLabel(label) ?? label?.trim() ?? `token-${maskToken(stripWorkOSPrefix(key.trim()))}`,
    apiKey: key.trim(),
    source,
    addedAt: Date.now()
  };
  pool.accounts.push(fresh);
  dedupePool(pool);
  pool.activeId ??= fresh.id;
  return pool.accounts.find((a) => a.id === fresh.id) ?? fresh;
}
var refreshFlight = /* @__PURE__ */ new Map();
async function refreshAccount(pool, acc, log) {
  const inflight = refreshFlight.get(acc.id);
  if (inflight) {
    await inflight;
    return;
  }
  const p = (async () => {
    const refreshToken = acc.refresh;
    if (!refreshToken) {
      throw new TerminalAuthError(`account ${acc.label ?? acc.id} has no refresh token \u2014 re-login required (/connect \u2192 cline-free)`);
    }
    await withFileLock(async () => {
      const disk = await loadPoolFile();
      const peer = disk.accounts.find((a) => a.id === acc.id);
      const peerTok = peer ? tokenOf(peer) : void 0;
      const mine = tokenOf(acc);
      if (peer?.refresh && peer?.expires && peer.expires - Date.now() >= REFRESH_BUFFER_MS && peerTok && mine && stripWorkOSPrefix(peerTok) !== stripWorkOSPrefix(mine)) {
        acc.access = peer.access;
        acc.apiKey = peer.apiKey;
        acc.refresh = peer.refresh;
        acc.expires = peer.expires;
        clearAuthHealth(acc);
        log("info", `cline-free: adopted peer-refreshed tokens for ${acc.label ?? acc.id}`);
        return;
      }
      const next = await refreshClineToken(refreshToken, { label: acc.label ?? acc.id, log });
      acc.access = next.access;
      acc.refresh = next.refresh;
      acc.expires = next.expires;
      clearAuthHealth(acc);
      await savePoolFile(pool);
    });
  })();
  refreshFlight.set(acc.id, p);
  try {
    await p;
  } finally {
    refreshFlight.delete(acc.id);
  }
}
function quarantineAccount(pool, acc, reason, log) {
  acc.authFailedAt = Date.now();
  acc.authFailedReason = reason;
  delete acc.limitedUntil;
  void savePoolFile(pool).catch(() => {
  });
  log(
    "error",
    `cline-free: account ${acc.label ?? acc.id} needs re-login (${reason}). Run /connect \u2192 cline-free and log in again; rotation continues on the remaining accounts.`,
    { accountId: acc.id }
  );
}
var PROBE_INTERVAL_MS = 15 * 60 * 1e3;
async function probeQuarantinedAccounts(pool, log) {
  const now = Date.now();
  let changed = false;
  for (const acc of pool.accounts) {
    if (!acc.authFailedAt) continue;
    if (acc.lastProbeAt && now - acc.lastProbeAt < PROBE_INTERVAL_MS) continue;
    acc.lastProbeAt = now;
    changed = true;
    const t = tokenOf(acc);
    if (t && (!acc.expires || acc.expires - now > 0)) {
      try {
        if (await validateClineToken(t)) {
          delete acc.authFailedAt;
          delete acc.authFailedReason;
          delete acc.lastProbeAt;
          log("info", `cline-free: account ${acc.label ?? acc.id} recovered on probe \u2014 back in rotation`, {
            accountId: acc.id
          });
        }
      } catch {
      }
    }
  }
  if (changed) void savePoolFile(pool).catch(() => {
  });
}
var rrCursors = /* @__PURE__ */ new Map();
function selectAccount(pool, now = Date.now(), model) {
  const candidates = allCandidates(pool);
  const healthy = candidates.filter((a) => {
    if (a.limitedUntil && a.limitedUntil > now) return false;
    const until = modelLimitUntil(a, model);
    return !until || until <= now;
  });
  if (healthy.length === 0) return void 0;
  const key = model ?? "";
  const cursor = rrCursors.get(key) ?? 0;
  const pick = healthy[cursor % healthy.length] ?? healthy[0];
  rrCursors.set(key, (cursor + 1) % healthy.length);
  return pick;
}
function markAccountLimited(pool, id, retryAfterMs, log, detail, model) {
  const acc = pool.accounts.find((a) => a.id === id);
  const until = Date.now() + (retryAfterMs ?? nextUtcMidnightMs() - Date.now());
  const name = acc?.label ?? id;
  if (acc) {
    if (model) {
      acc.modelLimits ??= {};
      acc.modelLimits[model] = until;
      if (!acc.limitedUntil || acc.limitedUntil < until) acc.limitedUntil = until;
    } else {
      acc.limitedUntil = until;
    }
    acc.lastError = `429${detail ? `: ${detail}` : ""}`;
  }
  log(
    "warn",
    `cline-free: account ${name} hit 429${model ? ` on ${model}` : ""} \u2014 cooling down until ${new Date(until).toISOString()}${detail ? ` (${detail})` : ""}`,
    { accountId: id, limitedUntil: until }
  );
  void savePoolFile(pool).catch(() => {
  });
}
function describeLimits(pool) {
  const limited = pool.accounts.filter((a) => a.limitedUntil && a.limitedUntil > Date.now());
  if (limited.length === 0) return "";
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}\u2192${new Date(a.limitedUntil).toISOString()}`).join(", ")}.`;
}

// src/modelList.ts
var CATALOG_URL = `${API_BASE}/api/v1/ai/cline/models`;
var MODELS_CACHE_FILE_NAME = "cline-free-models.json";
function modelsCachePath() {
  const override = process.env.CLINE_FREE_MODELS_FILE?.trim();
  if (override) return override;
  const file = poolFilePath();
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return `${slash >= 0 ? file.slice(0, slash + 1) : ""}${MODELS_CACHE_FILE_NAME}`;
}
function validEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => typeof m?.id === "string" && m.id.length > 0);
}
async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "opencode-cline-free" }
    });
    if (!res.ok) return void 0;
    return await res.json();
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchLiveFreeModels(timeoutMs = 12e3) {
  const payload = await getJson(RECOMMENDED_URL, timeoutMs);
  const free = validEntries(payload?.free);
  return free.length > 0 ? free : void 0;
}
var perMillion = (v) => {
  const n = v === void 0 ? NaN : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : void 0;
};
function toAutoMeta(m) {
  const context = m.top_provider?.context_length ?? m.context_length;
  const output = m.top_provider?.max_completion_tokens;
  const input = m.architecture?.input_modalities?.map((x) => x === "file" ? "pdf" : x);
  const pIn = perMillion(m.pricing?.prompt);
  const pOut = perMillion(m.pricing?.completion);
  const params = m.supported_parameters;
  return {
    ...context && context > 0 ? { limit: { context, output: output && output > 0 ? Math.min(output, context) : 32e3 } } : {},
    ...input && input.length > 0 ? { input } : {},
    ...pIn !== void 0 && pOut !== void 0 ? { cost: { input: pIn, output: pOut, cache_read: perMillion(m.pricing?.input_cache_read) ?? 0 } } : {},
    ...Array.isArray(params) ? { reasoning: params.includes("reasoning") || params.includes("reasoning_effort") } : {}
  };
}
function matchMetadata(ids, catalog) {
  const byId = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  for (const m of catalog) {
    if (typeof m?.id !== "string") continue;
    byId.set(m.id, m);
    const name = m.id.split("/").pop();
    if (!name.includes(":") && !byName.has(name)) byName.set(name, m);
  }
  const out = {};
  for (const id of ids) {
    const name = id.split("/").pop().replace(/:free$/, "");
    const row = byId.get(id) ?? byName.get(name);
    if (row) out[id] = toAutoMeta(row);
  }
  return out;
}
async function fetchCatalogMetadata(ids, timeoutMs = 12e3) {
  const payload = await getJson(CATALOG_URL, timeoutMs);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return matchMetadata(ids, rows);
}
async function readModelsCache() {
  try {
    const { readFile } = await import("node:fs/promises");
    const data = JSON.parse(await readFile(modelsCachePath(), "utf8"));
    const free = validEntries(data.free);
    return free.length > 0 ? { entries: free, meta: data.meta ?? {} } : void 0;
  } catch {
    return void 0;
  }
}
async function writeModelsCache(free, meta = {}) {
  const { mkdir, writeFile, rename, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const file = modelsCachePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const body = { version: 2, fetchedAt: Date.now(), free, meta };
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2));
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw e;
  }
}
async function refreshAndCache(timeoutMs, log) {
  const live = await fetchLiveFreeModels(timeoutMs);
  if (!live) return void 0;
  const entries = withExtraModels(live);
  const meta = await fetchCatalogMetadata(
    entries.map((e) => e.id),
    timeoutMs
  ).catch(() => ({}));
  await writeModelsCache(live, meta).catch(
    (e) => log?.("warn", `cline-free: could not save model cache: ${e instanceof Error ? e.message : String(e)}`)
  );
  return { entries, meta };
}
async function loadFreeModels(log, timeoutMs = 12e3) {
  const cached = await readModelsCache();
  if (cached) {
    const refreshed = refreshAndCache(timeoutMs, log).catch(() => void 0);
    return { entries: withExtraModels(cached.entries), meta: cached.meta, source: "cache", refreshed };
  }
  const live = await refreshAndCache(timeoutMs, log).catch(() => void 0);
  if (live) return { ...live, source: "live", refreshed: Promise.resolve(void 0) };
  return { entries: withExtraModels(FALLBACK_FREE), meta: {}, source: "fallback", refreshed: Promise.resolve(void 0) };
}

// src/router.ts
function createRoutedFetch(pool, log, baseFetch = (input, init) => globalThis.fetch(input, init)) {
  const origFetch = baseFetch;
  return (async (input, init) => {
    let url;
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input?.url === "string" ? input.url : "";
    } catch {
      return origFetch(input, init);
    }
    if (!isRoutableUrl(url)) return origFetch(input, init);
    let method = "POST";
    let headers = new Headers();
    let body = null;
    let signal;
    try {
      if (typeof input === "string" || input instanceof URL) {
        method = init?.method ?? "POST";
        headers = new Headers(init?.headers);
        signal = init?.signal;
        const b = init?.body;
        if (typeof b === "string") body = new TextEncoder().encode(b).buffer;
        else if (b instanceof ArrayBuffer) body = b;
        else if (ArrayBuffer.isView(b)) body = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        else if (b != null) {
          return origFetch(input, init);
        }
      } else {
        const req = input;
        method = req.method ?? init?.method ?? "POST";
        headers = new Headers(req.headers);
        for (const [k, v] of new Headers(init?.headers ?? {})) headers.set(k, v);
        signal = init?.signal ?? req.signal;
        const buf = await req.clone().arrayBuffer().catch(() => null);
        body = buf && buf.byteLength > 0 ? buf : null;
      }
    } catch {
      return origFetch(input, init);
    }
    const incomingAuth = headers.get("authorization") ?? "";
    const incomingToken = incomingAuth.replace(/^bearer\s+/i, "");
    const now = Date.now();
    const reqModel = modelOfRequest(url, body);
    const paid = isPaidModel(reqModel);
    pruneLimits(pool, now);
    const first = incomingToken && findByToken(pool, incomingToken) ? { token: incomingToken, accountId: findByToken(pool, incomingToken).id } : void 0;
    const tried = /* @__PURE__ */ new Set();
    const refreshedInRequest = /* @__PURE__ */ new Set();
    let lastRes;
    let lastAuthRes;
    const maxAttempts = allCandidates(pool).length + 1;
    const readSnippet = async (res) => {
      try {
        return (await res.clone().text().catch(() => "") || "").slice(0, 300);
      } catch {
        return "";
      }
    };
    const keepForReturn = (res) => res.clone();
    const drain = async (res) => {
      try {
        await res.arrayBuffer().catch(() => {
        });
      } catch {
      }
    };
    const cleanDetail = (snippet) => snippet.replace(/\s+/g, " ").trim().slice(0, 160) || void 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (paid && tried.size > 0) break;
      let token;
      let accountId;
      const firstAcc = first ? pool.accounts.find((a) => a.id === first.accountId) : void 0;
      const firstLimited = firstAcc ? (modelLimitUntil(firstAcc, reqModel) ?? 0) > now : false;
      if (attempt === 0 && first && !firstLimited) {
        ;
        ({ token, accountId } = first);
      } else {
        if (attempt === 0 && !first && incomingToken) {
          token = incomingToken;
        } else {
          const next = selectAccount(pool, Date.now(), reqModel);
          if (!next) break;
          const t = tokenOf(next);
          if (!t || tried.has(next.id)) continue;
          token = t;
          accountId = next.id;
        }
      }
      if (accountId) {
        if (tried.has(accountId)) continue;
        tried.add(accountId);
      } else if (tried.has(`raw:${stripWorkOSPrefix(token)}`)) {
        continue;
      } else {
        tried.add(`raw:${stripWorkOSPrefix(token)}`);
      }
      const h = new Headers(headers);
      h.set("authorization", `Bearer ${withWorkOSPrefix(token)}`);
      let res;
      try {
        res = await origFetch(url, { method, headers: h, body, signal });
      } catch (e) {
        throw e;
      }
      if (res.status === 401 || res.status === 403) {
        const snippet2 = await readSnippet(res);
        if (!isAuthFailure(res.status, snippet2)) {
          if (accountId) {
            pool.activeId = accountId;
            const acc2 = pool.accounts.find((a) => a.id === accountId);
            if (acc2) {
              acc2.lastUsed = Date.now();
              void savePoolFile(pool).catch(() => {
              });
            }
          }
          return res;
        }
        const detail2 = cleanDetail(snippet2);
        let acc = accountId ? pool.accounts.find((a) => a.id === accountId) : void 0;
        let staleCache = false;
        if (!acc) {
          const ukey = clineUserKey(token);
          const owner = ukey ? pool.accounts.find(
            (a) => a.refresh && tokenOf(a) && sameAccount(tokenOf(a), token) && (a.expires === void 0 || a.expires - Date.now() > REFRESH_BUFFER_MS)
          ) : void 0;
          if (owner) {
            staleCache = true;
            accountId = owner.id;
            acc = owner;
            log("info", `cline-free: stale cached token (${maskToken(token)}) matched to ${owner.label ?? owner.id} by user key \u2014 replaying with its current session`);
          }
        }
        if (staleCache && acc) {
          const current = tokenOf(acc);
          const h2 = new Headers(headers);
          h2.set("authorization", `Bearer ${withWorkOSPrefix(current)}`);
          const res2 = await origFetch(url, { method, headers: h2, body, signal });
          if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
            pool.activeId = acc.id;
            acc.lastUsed = Date.now();
            void savePoolFile(pool).catch(() => {
            });
            log("info", `cline-free: request recovered on ${acc.label ?? acc.id} with its current session (stale cached token)`);
            await drain(res).catch(() => {
            });
            return res2;
          }
          if (res2.status === 429) {
            const snippet22 = await readSnippet(res2);
            const detail22 = cleanDetail(snippet22);
            lastRes = keepForReturn(res2);
            await drain(res).catch(() => {
            });
            await drain(res2).catch(() => {
            });
            markAccountLimited(pool, acc.id, parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail22), log, detail22, reqModel);
            continue;
          }
          lastAuthRes = keepForReturn(res2);
          await drain(res).catch(() => {
          });
          await drain(res2).catch(() => {
          });
        }
        if (acc?.refresh && !refreshedInRequest.has(acc.id)) {
          refreshedInRequest.add(acc.id);
          try {
            await refreshAccount(pool, acc, log);
            const fresh = tokenOf(acc);
            if (fresh) {
              const h2 = new Headers(headers);
              h2.set("authorization", `Bearer ${withWorkOSPrefix(fresh)}`);
              const res2 = await origFetch(url, { method, headers: h2, body, signal });
              if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
                pool.activeId = acc.id;
                acc.lastUsed = Date.now();
                void savePoolFile(pool).catch(() => {
                });
                if (attempt > 0)
                  log("info", `cline-free: request recovered on ${acc.label ?? acc.id} after re-auth (attempt ${attempt + 1})`);
                else log("info", `cline-free: request recovered on ${acc.label ?? acc.id} after silent refresh`);
                await drain(res).catch(() => {
                });
                return res2;
              }
              if (res2.status === 429) {
                const snippet23 = await readSnippet(res2);
                const detail22 = cleanDetail(snippet23);
                lastRes = keepForReturn(res2);
                await drain(res).catch(() => {
                });
                await drain(res2).catch(() => {
                });
                markAccountLimited(pool, acc.id, parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail22), log, detail22, reqModel);
                continue;
              }
              const snippet22 = await readSnippet(res2);
              lastAuthRes = keepForReturn(res2);
              await drain(res).catch(() => {
              });
              await drain(res2).catch(() => {
              });
              quarantineAccount(
                pool,
                acc,
                `Cline rejected refreshed token (HTTP ${res2.status}${cleanDetail(snippet22) ? `: ${cleanDetail(snippet22)}` : ""})`,
                log
              );
              continue;
            }
          } catch (e) {
            lastAuthRes = keepForReturn(res);
            await drain(res).catch(() => {
            });
            if (e instanceof TerminalAuthError) {
              quarantineAccount(pool, acc, e.message, log);
            } else {
              log("warn", `cline-free: token refresh failed for ${acc.label ?? acc.id}: ${e instanceof Error ? e.message : String(e)} \u2014 trying next account`, { accountId: acc.id });
              acc.lastError = "refresh failed";
              void savePoolFile(pool).catch(() => {
              });
            }
            continue;
          }
        }
        if (acc) {
          lastAuthRes = keepForReturn(res);
          await drain(res).catch(() => {
          });
          quarantineAccount(pool, acc, `Cline returned HTTP ${res.status}${detail2 ? `: ${detail2}` : ""}`, log);
        } else {
          log("warn", `cline-free: 401/403 on untracked identity (${maskToken(token)})${detail2 ? ` \u2014 ${detail2}` : ""}`);
          return res;
        }
        continue;
      }
      if (res.status !== 429) {
        if (accountId) {
          pool.activeId = accountId;
          const acc = pool.accounts.find((a) => a.id === accountId);
          if (acc) {
            acc.lastUsed = Date.now();
            void savePoolFile(pool).catch(() => {
            });
          }
        }
        if (attempt > 0) log("info", `cline-free: request recovered on ${pool.accounts.find((a) => a.id === accountId)?.label ?? "fallback account"} after 429/re-auth (attempt ${attempt + 1})`);
        return res;
      }
      const snippet = await readSnippet(res);
      lastRes = keepForReturn(res);
      await drain(res).catch(() => {
      });
      const retryAfter = parseRetryAfterMs(res) ?? parseRetryAfterFromBody(cleanDetail(snippet));
      const detail = cleanDetail(snippet);
      if (accountId && pool.accounts.some((a) => a.id === accountId)) {
        markAccountLimited(pool, accountId, retryAfter, log, detail, reqModel);
      } else {
        log("warn", `cline-free: 429 on untracked identity (${maskToken(token)})${detail ? ` \u2014 ${detail}` : ""}`);
        break;
      }
    }
    if (lastAuthRes && !lastRes) {
      const quarantined = pool.accounts.filter((a) => a.authFailedAt).map((a) => `${a.label ?? a.id}`).join(", ");
      log("error", `cline-free: all ${tried.size} account(s) rejected auth (401/403). ${quarantined ? `Quarantined: ${quarantined}. ` : ""}Run /connect \u2192 cline-free and log in again; rotation continues when a healthy account exists.`);
      return lastAuthRes;
    }
    if (lastRes) {
      const waiting = pool.accounts.filter((a) => a.limitedUntil && a.limitedUntil > Date.now()).map((a) => `${a.label ?? a.id}\u2192${new Date(a.limitedUntil).toISOString()}`).join(", ");
      log("error", `cline-free: all ${tried.size} account(s) hit 429 daily quota. ${waiting ? `Cooling: ${waiting}. ` : ""}Add another Cline account via /connect to keep going.`);
      const earliest = [...pool.accounts].filter((a) => tokenOf(a)).sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0))[0];
      const t = earliest ? tokenOf(earliest) : void 0;
      if (!paid && earliest && t) {
        const h = new Headers(headers);
        h.set("authorization", `Bearer ${withWorkOSPrefix(t)}`);
        try {
          return await origFetch(url, { method, headers: h, body, signal });
        } catch (e) {
          throw e;
        }
      }
      return lastRes;
    }
    return origFetch(input, init);
  });
}

// src/plugin.ts
var ClineFreePlugin = async ({ client }) => {
  const log = (level, message, extra) => {
    void client.app.log({ body: { service: "cline-free", level, message, ...extra ? { extra } : {} } }).catch(() => {
    });
  };
  const pool = await loadPoolFile();
  {
    const pruned = pruneLimits(pool);
    const deduped = dedupePool(pool);
    if (pruned || deduped) void savePoolFile(pool).catch(() => {
    });
    if (deduped) log("info", `cline-free: removed duplicate login(s) \u2014 ${pool.accounts.length} unique account(s) left`);
  }
  const routedFetch = createRoutedFetch(pool, log);
  const { entries: free, meta, source, refreshed } = await loadFreeModels(log);
  const buildModels = (list, autoMeta) => {
    const out = {};
    for (const entry of list) out[entry.id] = modelConfig(entry, autoMeta[entry.id]);
    return out;
  };
  await client.app.log({
    body: {
      service: "cline-free",
      level: "info",
      message: `Loaded ${free.length} Cline models (${source})`,
      extra: { models: free.map((m) => m.id) }
    }
  }).catch(() => {
  });
  const seeded = allCandidates(pool).length;
  if (seeded > 0) {
    log("info", `cline-free: ${pool.accounts.length} stored account(s) + env merged \u2192 ${seeded} rotation candidate(s)`, {
      accounts: pool.accounts.map((a) => ({ id: a.id, label: a.label, source: a.source }))
    });
  }
  return {
    config: async (config) => {
      const latest = await Promise.race([refreshed, sleep(1500).then(() => void 0)]) ?? { entries: free, meta };
      const models = buildModels(latest.entries, latest.meta);
      config.provider ??= {};
      const existing = config.provider[PROVIDER_ID] ?? {};
      const existingModels = existing.models ?? {};
      config.provider[PROVIDER_ID] = {
        name: "Cline Free",
        npm: "@ai-sdk/openai-compatible",
        ...existing,
        options: {
          ...existing.options ?? {},
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
            ...existing.options?.headers ?? {}
          }
        },
        // User-declared models win; we only add missing free ids.
        models: { ...models, ...existingModels }
      };
    },
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth, provider) => {
        const baseHeaders = { "X-CLIENT-TYPE": "opencode" };
        if (pruneLimits(pool) || dedupePool(pool)) void savePoolFile(pool).catch(() => {
        });
        const auth = await getAuth().catch(() => void 0);
        if (auth?.type === "api" && typeof auth.key === "string" && auth.key.trim()) {
          const snapshot = JSON.stringify(pool.accounts);
          upsertApiAccount(pool, String(auth.key), void 0);
          if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {
          });
        } else if (auth?.type === "oauth" && typeof auth.access === "string") {
          const snapshot = JSON.stringify(pool.accounts);
          const acc = upsertOAuthAccount(
            pool,
            { access: String(auth.access), refresh: String(auth.refresh ?? ""), expires: Number(auth.expires ?? 0) },
            typeof auth.accountId === "string" ? auth.accountId : void 0
          );
          if ((!acc.label || acc.label === auth.accountId) && isGenericLabel(acc.label)) {
            const knownEmail = normalizeEmailLabel(typeof auth.accountId === "string" ? auth.accountId : void 0) ?? payloadEmail(String(auth.access));
            if (knownEmail) {
              acc.label = knownEmail;
              void savePoolFile(pool).catch(() => {
              });
            } else {
              void fetchUserEmail(String(auth.access)).then((email) => {
                if (email) {
                  acc.label = email;
                  void savePoolFile(pool).catch(() => {
                  });
                }
              });
            }
          }
          if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {
          });
        }
        let picked = selectAccount(pool, Date.now());
        if (!picked && pool.accounts.some((a) => a.authFailedAt)) {
          await probeQuarantinedAccounts(pool, log);
          picked = selectAccount(pool, Date.now());
        }
        if (!picked) {
          const candidates = allCandidates(pool);
          if (candidates.length === 0) return {};
          const earliest = [...candidates].sort((a, b) => (b.limitedUntil ?? 0) - (a.limitedUntil ?? 0))[0];
          const t = tokenOf(earliest);
          if (!t) return {};
          log("warn", `cline-free: all accounts cooling down \u2014 next reset ${new Date(earliest.limitedUntil ?? Date.now()).toISOString()}${describeLimits(pool)}`);
          return { apiKey: withWorkOSPrefix(t), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch };
        }
        const useFallback = (exceptId) => {
          const fb = selectAccount(pool, Date.now());
          const ft = fb ? tokenOf(fb) : void 0;
          if (fb && ft && fb.id !== exceptId) {
            pool.activeId = fb.id;
            fb.lastUsed = Date.now();
            void savePoolFile(pool).catch(() => {
            });
            return { apiKey: withWorkOSPrefix(ft), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch };
          }
          return void 0;
        };
        const needsRefresh = !!picked.access && typeof picked.expires === "number" && picked.expires - Date.now() < REFRESH_BUFFER_MS;
        if (needsRefresh && !picked.refresh) {
          quarantineAccount(pool, picked, "access token expired and no refresh token is stored", log);
          const fb = useFallback(picked.id);
          if (fb) return fb;
        } else if (needsRefresh) {
          try {
            await refreshAccount(pool, picked, log);
            const t = tokenOf(picked);
            if (auth?.type === "oauth" && typeof auth.access === "string" && t && sameAccount(auth.access, t)) {
              await provider?.update?.({
                access: stripWorkOSPrefix(t),
                refresh: picked.refresh,
                expires: picked.expires
              }).catch(() => {
              });
            }
          } catch (e) {
            if (e instanceof TerminalAuthError) {
              quarantineAccount(pool, picked, e.message, log);
            } else {
              log("warn", `cline-free: token refresh failed for ${picked.label ?? picked.id}: ${e instanceof Error ? e.message : String(e)} \u2014 trying next account`, { accountId: picked.id });
              picked.lastError = "refresh failed";
              void savePoolFile(pool).catch(() => {
              });
            }
            const fb = useFallback(picked.id);
            if (fb) return fb;
          }
        }
        const token = tokenOf(picked);
        if (!token) return {};
        pool.activeId = picked.id;
        picked.lastUsed = Date.now();
        return { apiKey: withWorkOSPrefix(token), baseURL: CHAT_BASE_URL, headers: baseHeaders, fetch: routedFetch };
      },
      methods: [
        {
          type: "oauth",
          label: "Cline account (free models, recommended)",
          async authorize() {
            const device = await startDeviceAuth();
            return {
              url: device.verificationUriComplete ?? device.verificationUri,
              instructions: `Open the URL (code ${device.userCode} is pre-filled). Already logged into Cline in this browser? Just click Confirm/Approve \u2014 no password needed. Otherwise log in with Google/GitHub/Microsoft, then approve. Then wait \u2014 OpenCode completes login automatically.`,
              method: "auto",
              callback: async () => {
                try {
                  const workos = await pollDeviceAuth(
                    device.deviceCode,
                    device.expiresInSeconds,
                    device.intervalSeconds
                  );
                  const creds = await registerWorkOSTokens(workos);
                  const email = await fetchUserEmail(creds.access);
                  const acc = upsertOAuthAccount(pool, creds, email, "oauth");
                  if (email) acc.label = email;
                  void savePoolFile(pool).catch(() => {
                  });
                  log("info", `cline-free: added account ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id });
                  return { type: "success", ...creds };
                } catch (e) {
                  log("warn", `cline-free: device authorization failed: ${e instanceof Error ? e.message : String(e)}`);
                  return { type: "failed" };
                }
              }
            };
          }
        },
        {
          type: "oauth",
          label: "Reuse Cline CLI login (this machine, 1 confirm)",
          async authorize() {
            const session = await readClineCliSession();
            if (!session) {
              throw new Error(
                "No Cline CLI login found on this machine (~/.cline/data/settings/providers.json). Run `cline auth` first, or pick another method."
              );
            }
            const who = session.email ? ` for ${session.email}` : "";
            return {
              url: "https://app.cline.bot/dashboard",
              instructions: `Found an existing Cline CLI login${who}. Confirm to connect it to OpenCode \u2014 no browser code needed.`,
              method: "auto",
              callback: async () => {
                try {
                  let { access, refresh, expires } = session;
                  if (!await validateClineToken(access) && refresh) {
                    try {
                      const next = await refreshClineToken(refresh, { label: session.email ?? "cli-import", log });
                      access = next.access;
                      refresh = next.refresh;
                      expires = next.expires;
                    } catch (e) {
                      log("warn", `cline-free: CLI-imported token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
                      return { type: "failed" };
                    }
                    if (!await validateClineToken(access)) {
                      return { type: "failed" };
                    }
                  } else if (!await validateClineToken(access)) {
                    return { type: "failed" };
                  }
                  const acc = upsertOAuthAccount(pool, { access, refresh, expires }, session.email, "cli");
                  if (session.email) acc.label = session.email;
                  void savePoolFile(pool).catch(() => {
                  });
                  log("info", `cline-free: added CLI-imported account ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id });
                  return { type: "success", access, refresh, expires };
                } catch {
                  return { type: "failed" };
                }
              }
            };
          }
        },
        {
          type: "api",
          label: "Cline token (manual)",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Paste your Cline token (workos:... or raw access token):",
              placeholder: "workos:..."
            }
          ],
          async authorize(inputs) {
            const key = inputs?.key?.trim();
            if (!key) return { type: "failed" };
            try {
              const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
                headers: { Authorization: `Bearer ${withWorkOSPrefix(key)}`, Accept: "application/json" }
              });
              if (!res.ok) return { type: "failed" };
            } catch {
              return { type: "failed" };
            }
            const email = await fetchUserEmail(key);
            const acc = upsertApiAccount(pool, key, email);
            if (email) acc.label = email;
            void savePoolFile(pool).catch(() => {
            });
            log("info", `cline-free: added manual token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id });
            return { type: "success", key };
          }
        }
      ]
    },
    tool: {
      cline_free_status: tool({
        description: "Show Cline Free account pool status: stored accounts, env accounts, which is active, and 429 cooldowns.",
        args: {},
        async execute() {
          pruneLimits(pool);
          if (dedupePool(pool)) void savePoolFile(pool).catch(() => {
          });
          const candidates = allCandidates(pool);
          const now = Date.now();
          const lines = pool.accounts.map((a) => {
            const t = tokenOf(a);
            const now2 = Date.now();
            const modelCd = a.modelLimits ? Object.entries(a.modelLimits).filter(([, until]) => until > now2).map(([m, until]) => `${m}\u2192${new Date(until).toISOString().slice(5, 16)}Z`).sort().join(", ") : "";
            const anyLimited = a.limitedUntil && a.limitedUntil > now2;
            const quarantined = !!a.authFailedAt;
            const flags = [
              a.id === pool.activeId ? "active" : "",
              modelCd || anyLimited ? "COOLDOWN" : "",
              modelCd,
              quarantined ? `NEEDS-RELOGIN${a.authFailedReason ? ` (${a.authFailedReason.slice(0, 80)})` : ""}` : "",
              a.source
            ].filter(Boolean).join(" | ");
            return `- ${a.label ?? a.id} [${a.id}] (${flags}) token ${t ? maskToken(t) : "?"}` + (a.expires ? ` expires ${new Date(a.expires).toISOString()}` : "");
          });
          const envCount = candidates.filter((a) => a.id.startsWith("env-")).length;
          const qCount = pool.accounts.filter((a) => a.authFailedAt).length;
          const header = `cline-free pool: ${pool.accounts.length} stored${qCount ? ` (${qCount} need re-login)` : ""} + ${envCount} env \u2192 ${candidates.length} rotation candidate(s). File: ${poolFilePath()}`;
          return lines.length > 0 ? `${header}
${lines.join("\n")}` : `${header}
(no accounts \u2014 run /connect and pick cline-free)`;
        }
      }),
      cline_free_remove: tool({
        description: "Remove a stored Cline Free account from the rotation pool by id (see cline_free_status). Env accounts cannot be removed here \u2014 unset the env var instead.",
        args: {
          id: tool.schema.string().describe("Account id (acc_...) from cline_free_status")
        },
        async execute(args) {
          const idx = pool.accounts.findIndex((a) => a.id === args.id);
          if (idx === -1) return `No stored account with id ${args.id}.`;
          const [removed] = pool.accounts.splice(idx, 1);
          if (pool.activeId === args.id) delete pool.activeId;
          await savePoolFile(pool).catch(() => {
          });
          log("info", `cline-free: removed account ${removed.label ?? removed.id}`, { accountId: args.id });
          return `Removed ${removed.label ?? removed.id} (${pool.accounts.length} stored left).`;
        }
      }),
      cline_free_add_token: tool({
        description: "Validate and add a Cline token (workos:... or raw) to the rotation pool.",
        args: {
          token: tool.schema.string().describe("Cline token (workos:... or raw access token)"),
          label: tool.schema.string().optional().describe("Friendly label (defaults to account email)")
        },
        async execute(args) {
          const key = args.token?.trim();
          if (!key) return "No token provided.";
          try {
            const res = await fetchWithTimeout(`${API_BASE}/api/v1/users/me`, {
              headers: { Authorization: `Bearer ${withWorkOSPrefix(key)}`, Accept: "application/json" }
            });
            if (!res.ok) return `Token rejected by Cline (HTTP ${res.status}). Not added.`;
          } catch (e) {
            return `Could not reach Cline: ${e instanceof Error ? e.message : String(e)}. Not added.`;
          }
          const email = await fetchUserEmail(key);
          const acc = upsertApiAccount(pool, key, args.label?.trim() || email);
          if (args.label?.trim()) acc.label = args.label.trim();
          else if (email) acc.label = email;
          await savePoolFile(pool).catch(() => {
          });
          log("info", `cline-free: added token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id });
          return `Added ${acc.label ?? acc.id} [${acc.id}] (${pool.accounts.length} stored total).`;
        }
      })
    }
  };
};

// src/index.ts
var __clineFreeTest = {
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
  savePoolFile
};
var index_default = {
  id: "cline-free",
  server: ClineFreePlugin
};
export {
  __clineFreeTest,
  index_default as default
};
