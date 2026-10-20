// src/core/constants.ts
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
var CLINE_HEADERS = {
  Accept: "application/json",
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "User-Agent": "Cline/4.1.23",
  "X-CLIENT-TYPE": "VSCode Extension",
  "X-CLIENT-VERSION": "4.1.23",
  "X-CORE-VERSION": "0.0.92",
  "X-PLATFORM": "Visual Studio Code",
  "X-PLATFORM-VERSION": "1.141.0",
  "X-IS-MULTIROOT": "false"
};

// src/core/http.ts
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
  outer?.throwIfAborted();
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new TransientAuthError(`request timed out after ${timeoutMs}ms: ${url}`)),
    timeoutMs
  );
  const onOuterAbort = () => ctrl.abort(outer.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  let onAbort = () => {
  };
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(ctrl.signal.reason);
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
  });
  const consume = async () => {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (ctrl.signal.aborted) {
      void res.body?.cancel().catch(() => {
      });
      throw ctrl.signal.reason;
    }
    const reader = res.body?.getReader();
    const cancel = () => {
      void reader?.cancel(ctrl.signal.reason).catch(() => {
      });
    };
    ctrl.signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks = [];
      let length = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          ctrl.signal.throwIfAborted();
          if (done) break;
          length += value.byteLength;
          if (length > 1024 * 1024) {
            cancel();
            throw new TransientAuthError("authentication response exceeded 1 MiB");
          }
          chunks.push(value);
        }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const buffered = new Response(res.body ? bytes : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
      for (const key of ["url", "redirected", "type"]) {
        Object.defineProperty(buffered, key, { value: res[key] });
      }
      return buffered;
    } finally {
      ctrl.signal.removeEventListener("abort", cancel);
      reader?.releaseLock();
    }
  };
  try {
    return await Promise.race([consume(), aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
    ctrl.signal.removeEventListener("abort", onAbort);
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
    return new TerminalAuthError(
      `${where}: HTTP ${status}${code ? ` (${code})` : ""}${extra} \u2014 retrying is unlikely to help`
    );
  }
  return new TransientAuthError(`${where}${extra}`);
}
async function withTransientRetries(fn, opts = {}) {
  const attempts = opts.attempts ?? TRANSIENT_MAX_ATTEMPTS;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      opts.signal?.throwIfAborted();
      if (e instanceof TerminalAuthError || isAbortError(e)) throw e;
      last = e;
      if (attempt === attempts - 1) break;
      const wait = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)] + Math.random() * 250;
      opts.log?.(
        "warn",
        `cline-free: attempt ${attempt + 1}/${attempts} failed${opts.label ? ` for ${opts.label}` : ""} (${e instanceof Error ? e.message : String(e)}) \u2014 retrying in ${Math.round(wait)}ms`
      );
      await new Promise((resolve, reject) => {
        const cleanup = () => opts.signal?.removeEventListener("abort", cancel);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, wait);
        const cancel = () => {
          clearTimeout(timer);
          cleanup();
          reject(opts.signal.reason);
        };
        opts.signal?.addEventListener("abort", cancel, { once: true });
        if (opts.signal?.aborted) cancel();
      });
    }
  }
  if (last instanceof TerminalAuthError) throw last;
  throw last instanceof Error ? last : new TransientAuthError(`operation failed: ${String(last)}`);
}

// src/core/auth.ts
async function startDeviceAuth(signal) {
  return withTransientRetries(
    async () => {
      const res = await fetchWithTimeout(`${WORKOS_API}/user_management/authorize/device`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID })
      });
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
    },
    { attempts: 2, label: "device authorization", signal }
  );
}
async function pollDeviceAuth(deviceCode, expiresInSeconds, intervalSeconds, signal) {
  const deadline = Date.now() + Math.max(30, expiresInSeconds - 10) * 1e3;
  let interval = Math.max(1, intervalSeconds);
  const aborted = () => new DOMException("Cline device login was cancelled.", "AbortError");
  const wait = (ms) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw aborted();
    let res;
    try {
      res = await fetchWithTimeout(`${WORKOS_API}/user_management/authenticate`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: WORKOS_CLIENT_ID
        })
      });
    } catch (e) {
      if (signal?.aborted) throw aborted();
      if (isAbortError(e)) throw e;
      await wait(interval * 1e3);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token && data.refresh_token) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    }
    if (data.error === "authorization_pending") {
      await wait(interval * 1e3);
      continue;
    }
    if (data.error === "slow_down") {
      interval += 5;
      await wait(interval * 1e3);
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
        const text2 = await res.text().catch(() => "");
        let code;
        let detail = `${res.status} ${res.statusText}`;
        if (text2) {
          try {
            const j = JSON.parse(text2);
            code = typeof j.error === "string" ? j.error.toLowerCase() : void 0;
            detail = (j.error_description ?? j.message ?? j.error ?? text2).slice(0, 200);
          } catch {
            detail = text2.slice(0, 200);
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
    const text2 = await res.text().catch(() => "");
    let code;
    let detail = `${res.status} ${res.statusText}`;
    if (text2) {
      try {
        const j = JSON.parse(text2);
        code = typeof j.error === "string" ? j.error.toLowerCase() : void 0;
        detail = (j.error_description ?? j.message ?? j.error ?? text2).slice(0, 200);
      } catch {
        detail = text2.slice(0, 200);
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

// src/core/models.ts
var DEFAULT_COST = { input: 0, output: 0, cache_read: 0 };
var DEFAULT_LIMIT = { context: 2e5, output: 32e3 };
var DEFAULT_INPUT = ["text"];
var DEFAULT_VARIANTS = ["low", "medium", "high"];
var FULL = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
var NO_NONE = ["minimal", "low", "medium", "high", "xhigh", "max"];
var MODELS = {
  // --- Free rotation registry (live discovery takes precedence) ---
  // Checked 2026-10-20. Limits/inputs from Cline's public catalog row
  // `minimax/minimax-m3.1-flash:free` (https://api.cline.bot/api/v1/ai/cline/models).
  // Efforts from https://platform.minimax.io/docs/api-reference/text-openai-api;
  // vendor-documented, not Cline probe-verified. Leave the base effort unset.
  "cline-free/minimax-m3.1-flash": {
    name: "MiniMax M3.1 Flash",
    description: "MiniMax M3.1 Flash \u2014 multimodal reasoning model.",
    status: "free",
    limit: { context: 1e6, output: 524288 },
    input: ["text", "image", "video"],
    variants: ["low", "medium", "high", "xhigh", "max"]
  },
  // Added 2026-10-11. Limits/cost/inputs from the catalog entry
  // `stepfun/step-5-preview`; efforts not probe-verified (DEFAULT_VARIANTS).
  "cline-free/step-5-preview": {
    name: "Step 5 Preview",
    description: "StepFun's flagship model for agentic work, built on a sparse Mixture-of-Experts.",
    status: "free",
    cost: { input: 1, output: 2.7, cache_read: 0.05 },
    limit: { context: 1e6, output: 64e3 },
    input: ["text", "image", "video"]
  },
  // Added 2026-10-11. Limits/cost/inputs from the catalog entry
  // `upstage/solar-mini4`; efforts not probe-verified (DEFAULT_VARIANTS).
  "cline-free/solar-mini4": {
    name: "Solar Mini 4",
    description: "Upstage's compact 35B mixture-of-experts (3B active).",
    status: "free",
    cost: { input: 0.05, output: 0.2, cache_read: 5e-3 },
    limit: { context: 524288, output: 131072 },
    input: ["text"]
  },
  "cline-free/mimo-v2.6-flash": {
    name: "MiMo V2.6 Flash",
    description: "Xiaomi MiMo 2.6 Flash \u2014 309B MoE (15B active), hybrid attention, multimodal.",
    status: "free",
    cost: { input: 0.14, output: 0.28, cache_read: 28e-4 },
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image", "video", "audio"],
    // Reasoning is on/off only: the catalog lists `reasoning` but not
    // `reasoning_effort`, and probes showed only `none` changes output.
    variants: ["none", "high"]
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
  // Added 2026-10-11. Limits/cost/inputs from the catalog entry
  // `xiaomi/mimo-v2.6-pro` (Cline's billed rates). Like V2.6 Flash, the
  // catalog lists `reasoning` but not `reasoning_effort` → on/off only.
  // Xiaomi's own endpoint is a thinking toggle (OpenRouter, models.dev).
  "xiaomi/mimo-v2.6-pro": {
    name: "MiMo V2.6 Pro",
    description: "Xiaomi MiMo 2.6 Pro \u2014 1T+ parameter flagship, multimodal \u2014 bills Cline credits (not free).",
    status: "paid",
    cost: { input: 0.435, output: 0.87, cache_read: 36e-4 },
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image", "video", "audio"],
    variants: ["none", "high"]
  },
  // Added 2026-10-11. Limits/cost/inputs from the catalog entry
  // `openai/gpt-6.1-sol` (Cline's billed rates; catalog `file` → pdf).
  // Efforts from OpenAI's model docs: low, medium (default), high, xhigh,
  // max — `none`/`minimal` unsupported (matches models.dev providers).
  "openai/gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    description: "OpenAI GPT-6.1 Sol \u2014 agentic coding, computer use, document-heavy work \u2014 bills Cline credits (not free).",
    status: "paid",
    cost: { input: 2, output: 10, cache_read: 0.1 },
    limit: { context: 105e4, output: 128e3 },
    input: ["text", "image", "pdf"],
    variants: ["low", "medium", "high", "xhigh", "max"]
  },
  // --- Rotated out (kept so metadata is right if they return) ---
  // Left the free list on 2026-10-06.
  "stealth/space-bunny-alpha": {
    name: "Space Bunny Alpha",
    description: "Anonymous large model with blazing-fast inference, strong coding, native multimodal input, and 1M context.",
    status: "stale",
    cost: { input: 0, output: 0, cache_read: 0 },
    limit: { context: 1e6, output: 524288 },
    input: ["text", "image", "video"],
    variants: NO_NONE
  },
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

// src/core/pool.ts
import { createHash, randomUUID } from "node:crypto";
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
  try {
    const parsed = new URL(url);
    return parsed.origin === API_BASE && !parsed.username && !parsed.password && /^\/api\/v1\/(?:chat\/)?completions\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}
function isAuthFailure(status, snippet) {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /unauthor|re-authenticate|reauthenticate|invalid_grant|invalid_token|expired|please .* (login|authenticate)/i.test(
    snippet
  );
}
var baselines = /* @__PURE__ */ new WeakMap();
var revivals = /* @__PURE__ */ new WeakMap();
var copy = (value) => structuredClone(value);
var equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var emptyPool = () => ({ version: 1, accounts: [] });
async function readPoolFile(file) {
  const { readFile } = await import("node:fs/promises");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return emptyPool();
    throw e;
  }
  const data = JSON.parse(raw);
  const accounts = Array.isArray(data.accounts) ? data.accounts.filter(
    (a) => !!a && typeof a.id === "string" && (typeof a.access === "string" || typeof a.apiKey === "string")
  ) : [];
  for (const a of accounts) migrateLimits(a);
  const removed = Array.isArray(data.removed) ? data.removed.filter((r) => typeof r === "string") : [];
  return {
    version: 1,
    activeId: typeof data.activeId === "string" ? data.activeId : void 0,
    accounts,
    ...removed.length ? { removed } : {}
  };
}
async function loadPoolFile() {
  let pool;
  try {
    pool = await readPoolFile(poolFilePath());
  } catch {
    pool = emptyPool();
  }
  baselines.set(pool, copy(pool));
  return pool;
}
var credentialKeys = ["access", "apiKey", "refresh", "expires"];
var healthKeys = /* @__PURE__ */ new Set([
  "limitedUntil",
  "modelLimits",
  "lastError",
  "authFailedAt",
  "authFailedReason",
  "lastProbeAt"
]);
var credentials = (a) => credentialKeys.map((k) => a[k]);
function rebaseCredentials(pool, peer) {
  const baseline = copy(baselines.get(pool) ?? emptyPool());
  const observed = baseline.accounts.find((a) => a.id === peer.id);
  if (observed) {
    for (const k of credentialKeys) {
      if (peer[k] === void 0) delete observed[k];
      else observed[k] = peer[k];
    }
  } else baseline.accounts.push(copy(peer));
  baselines.set(pool, baseline);
}
function mergeAccount(base, local, disk, explicitLogin) {
  const result = copy(disk);
  const peerRotated = !equal(credentials(base), credentials(disk));
  if (explicitLogin || !peerRotated && !equal(credentials(base), credentials(local))) {
    for (const k of explicitLogin ? [...credentialKeys, ...healthKeys] : credentialKeys) {
      const value = local[k];
      if (value === void 0) delete result[k];
      else result[k] = copy(value);
    }
  }
  for (const k of /* @__PURE__ */ new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (credentialKeys.includes(k) || k === "id") continue;
    if ((peerRotated || explicitLogin) && healthKeys.has(k)) continue;
    const b = base[k];
    const l = local[k];
    if (equal(b, l)) continue;
    if (k === "modelLimits") {
      const merged = { ...disk.modelLimits };
      for (const m of /* @__PURE__ */ new Set([...Object.keys(base.modelLimits ?? {}), ...Object.keys(local.modelLimits ?? {})])) {
        const before = base.modelLimits?.[m], after = local.modelLimits?.[m];
        if (before === after) continue;
        if (after !== void 0) merged[m] = Math.max(merged[m] ?? 0, after);
        else if (merged[m] === before) delete merged[m];
      }
      if (Object.keys(merged).length) result.modelLimits = merged;
      else delete result.modelLimits;
    } else if (l === void 0) {
      if (equal(disk[k], b)) delete result[k];
    } else if (k === "lastUsed" || k === "limitedUntil") {
      ;
      result[k] = Math.max(Number(disk[k]) || 0, Number(l));
    } else {
      ;
      result[k] = copy(l);
    }
  }
  return result;
}
function mergePool(base, local, disk, revived = /* @__PURE__ */ new Map()) {
  const result = copy(disk);
  const removed = new Set(disk.removed);
  for (const r of base.removed ?? []) if (!local.removed?.includes(r)) removed.delete(r);
  for (const r of revived.keys()) removed.delete(r);
  for (const r of local.removed ?? []) if (!base.removed?.includes(r)) removed.add(r);
  result.removed = [...removed].slice(-MAX_REMOVED);
  if (!result.removed.length) delete result.removed;
  const before = new Map(base.accounts.map((a) => [a.id, a]));
  const after = new Map(local.accounts.map((a) => [a.id, a]));
  result.accounts = result.accounts.filter((a) => !(before.has(a.id) && !after.has(a.id)));
  for (const a of local.accounts) {
    const old = before.get(a.id);
    const idx = result.accounts.findIndex((d) => d.id === a.id);
    if (old) {
      if (idx >= 0) result.accounts[idx] = mergeAccount(old, a, result.accounts[idx], revived.has(identityHash(tokenOf(a) ?? "")));
      else if (revived.has(identityHash(tokenOf(a) ?? ""))) result.accounts.push(copy(a));
    } else if (idx < 0) {
      const token = tokenOf(a);
      if (!token || !removed.has(identityHash(token))) result.accounts.push(copy(a));
    }
  }
  result.accounts = result.accounts.filter((a) => !isRemoved(result, tokenOf(a) ?? ""));
  if (local.activeId !== base.activeId) result.activeId = local.activeId;
  if (!result.accounts.some((a) => a.id === result.activeId)) result.activeId = result.accounts[0]?.id;
  return result;
}
function adoptPool(pool, next) {
  const existing = new Map(pool.accounts.map((a) => [a.id, a]));
  pool.accounts = next.accounts.map((a) => {
    const current = existing.get(a.id);
    if (!current) return a;
    for (const k of Object.keys(current)) delete current[k];
    Object.assign(current, a);
    return current;
  });
  pool.activeId = next.activeId;
  if (next.removed) pool.removed = next.removed;
  else delete pool.removed;
}
async function persistPoolFile(pool, file) {
  const { writeFile, chmod, rename, unlink } = await import("node:fs/promises");
  const base = baselines.get(pool) ?? emptyPool();
  const snapshot = copy(pool);
  const revived = new Map(revivals.get(pool));
  const merged = mergePool(base, snapshot, await readPoolFile(file), revived);
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 384, flag: "wx" });
    await chmod(tmp, 384);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw e;
  }
  adoptPool(pool, mergePool(snapshot, pool, merged, new Map(revivals.get(pool))));
  baselines.set(pool, copy(merged));
  for (const [r, intent] of revived) {
    if (revivals.get(pool)?.get(r) === intent) revivals.get(pool)?.delete(r);
  }
}
async function savePoolFile(pool) {
  const file = poolFilePath();
  await lockPoolFile(file, () => persistPoolFile(pool, file));
}
async function lockPoolFile(file, fn, opts = {}) {
  const { mkdir, open, rename, unlink, rmdir, stat, readFile, readdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const ownerName = `owner-${process.pid}-${randomUUID()}`;
  const candidate = `${lock}.${ownerName}`;
  const timeoutMs = opts.timeoutMs ?? 12e4;
  const staleMs = opts.staleMs ?? 15e3;
  const start = Date.now();
  const dead = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  };
  await mkdir(candidate, { mode: 448 });
  const owner = await open(`${candidate}/${ownerName}`, "wx", 384).catch(async (e) => {
    await rmdir(candidate).catch(() => {
    });
    throw e;
  });
  let beat;
  let acquired = false;
  try {
    await owner.writeFile(`${process.pid}`);
    while (true) {
      try {
        await rename(candidate, lock);
        acquired = true;
        break;
      } catch (e) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(e.code ?? "")) throw e;
        try {
          const st = await stat(lock);
          if (st.isDirectory()) {
            const names = await readdir(lock);
            for (const name of names) {
              if (!/^owner-\d+-[\da-f-]+$/.test(name)) continue;
              const path = `${lock}/${name}`;
              const ownerStat = await stat(path);
              const pid = Number(await readFile(path, "utf8"));
              if (dead(pid) && Date.now() - ownerStat.mtimeMs > staleMs) await unlink(path).catch(() => {
              });
            }
            await rmdir(lock).catch(() => {
            });
          } else if (Date.now() - st.mtimeMs > staleMs && dead(Number(await readFile(lock, "utf8")))) {
            await unlink(lock).catch(() => {
            });
          }
        } catch {
        }
        if (Date.now() - start > timeoutMs) throw new TransientAuthError(`timed out waiting for pool lock (${lock})`);
        await sleep(50 + Math.random() * 100);
      }
    }
    beat = setInterval(
      () => {
        const now = /* @__PURE__ */ new Date();
        void owner.utimes(now, now).catch(() => {
        });
      },
      Math.max(10, Math.floor(staleMs / 3))
    );
    beat.unref();
    return await fn();
  } finally {
    if (beat) clearInterval(beat);
    await owner.close();
    if (acquired) {
      await unlink(`${lock}/${ownerName}`).catch(() => {
      });
      await rmdir(lock).catch(() => {
      });
    } else {
      await unlink(`${candidate}/${ownerName}`).catch(() => {
      });
      await rmdir(candidate).catch(() => {
      });
    }
  }
}
function migrateLimits(a) {
  if (a.limitsVersion === 2) return;
  const maxModel = Math.max(0, ...Object.values(a.modelLimits ?? {}));
  if (maxModel && a.limitedUntil === maxModel) delete a.limitedUntil;
  a.limitsVersion = 2;
}
function cooldownUntil(a, model) {
  migrateLimits(a);
  return Math.max(
    a.limitedUntil ?? 0,
    model ? modelLimitUntil(a, model) ?? 0 : Math.max(0, ...Object.values(a.modelLimits ?? {}))
  );
}
function pruneLimits(pool, now = Date.now()) {
  let changed = false;
  for (const a of trackedAccounts(pool)) {
    migrateLimits(a);
    if (a.limitedUntil && a.limitedUntil <= now) {
      delete a.limitedUntil;
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
    if (!a.limitedUntil && !a.modelLimits && a.lastError?.startsWith("429")) {
      delete a.lastError;
      changed = true;
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
var envAccounts = /* @__PURE__ */ new WeakMap();
function envAccount(pool, id, key, label) {
  let byId = envAccounts.get(pool);
  if (!byId) {
    byId = /* @__PURE__ */ new Map();
    envAccounts.set(pool, byId);
  }
  const existing = byId.get(id);
  if (existing) {
    existing.label = label;
    return existing;
  }
  const acc = { id, label, apiKey: key, source: "env", addedAt: 0 };
  byId.set(id, acc);
  return acc;
}
function trackedAccounts(pool) {
  return [...pool.accounts, ...envAccounts.get(pool)?.values() ?? []];
}
function findAccount(pool, id) {
  if (!id) return void 0;
  return pool.accounts.find((a) => a.id === id) ?? envAccounts.get(pool)?.get(id);
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
    const fp = createHash("sha256").update(k).digest("hex");
    const acc = envAccount(
      pool,
      `env-${fp}`,
      key.trim(),
      envKeys.length > 1 ? `env-${i + 1} (${maskToken(key)})` : `env (${maskToken(key)})`
    );
    if (acc.authFailedAt) return;
    out.push(acc);
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
function clearAuthHealth(acc, options = {}) {
  acc.limitsVersion = 2;
  if (!options.preserveModelLimits) delete acc.modelLimits;
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
var MAX_REMOVED = 200;
function identityHash(token) {
  const id = clineUserKey(token) ?? `tok:${stripWorkOSPrefix(token)}`;
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}
function isRemoved(pool, token) {
  return !!pool.removed?.includes(identityHash(token));
}
function rememberRemoval(pool, token) {
  const id = identityHash(token);
  const list = (pool.removed ?? []).filter((r) => r !== id);
  list.push(id);
  pool.removed = list.slice(-MAX_REMOVED);
}
function forgetRemoval(pool, token) {
  const id = identityHash(token);
  const revived = revivals.get(pool) ?? /* @__PURE__ */ new Map();
  revived.set(id, /* @__PURE__ */ Symbol());
  revivals.set(pool, revived);
  if (!pool.removed) return;
  pool.removed = pool.removed.filter((r) => r !== id);
  if (pool.removed.length === 0) delete pool.removed;
}
var refreshFlights = /* @__PURE__ */ new WeakMap();
async function refreshAccount(pool, acc, log2) {
  const file = poolFilePath();
  const flightKey = `${file}\0${acc.id}`;
  const refreshFlight = refreshFlights.get(pool) ?? /* @__PURE__ */ new Map();
  refreshFlights.set(pool, refreshFlight);
  const inflight = refreshFlight.get(flightKey);
  if (inflight) {
    await inflight;
    return;
  }
  const p = (async () => {
    await lockPoolFile(file, async () => {
      const disk = await readPoolFile(file);
      const peer = disk.accounts.find((a) => a.id === acc.id);
      if (!peer && baselines.get(pool)?.accounts.some((a) => a.id === acc.id) || tokenOf(acc) && isRemoved(disk, tokenOf(acc))) {
        adoptPool(pool, disk);
        baselines.set(pool, copy(disk));
        throw new TerminalAuthError("account removed by another process \u2014 re-login required");
      }
      const observed = baselines.get(pool)?.accounts.find((a) => a.id === acc.id);
      const peerChanged = !!peer && (!observed || !equal(credentials(peer), credentials(observed)));
      const peerTok = peer ? tokenOf(peer) : void 0;
      const mine = tokenOf(acc);
      if (peerChanged && peer?.refresh && peer?.expires && peer.expires - Date.now() >= REFRESH_BUFFER_MS && peerTok && mine && (stripWorkOSPrefix(peerTok) !== stripWorkOSPrefix(mine) || peer.refresh !== acc.refresh)) {
        acc.access = peer.access;
        acc.apiKey = peer.apiKey;
        acc.refresh = peer.refresh;
        acc.expires = peer.expires;
        const modelLimits = { ...acc.modelLimits };
        for (const [model, until] of Object.entries(peer.modelLimits ?? {})) {
          modelLimits[model] = Math.max(modelLimits[model] ?? 0, until);
        }
        if (Object.keys(modelLimits).length) acc.modelLimits = modelLimits;
        clearAuthHealth(acc, { preserveModelLimits: true });
        rebaseCredentials(pool, peer);
        log2("info", `cline-free: adopted peer-refreshed tokens for ${acc.label ?? acc.id}`);
        return;
      }
      const refreshToken = peerChanged ? peer?.refresh ?? acc.refresh : acc.refresh;
      if (!refreshToken) {
        throw new TerminalAuthError(
          `account ${acc.label ?? acc.id} has no refresh token \u2014 re-login required (/connect \u2192 cline-free)`
        );
      }
      const next = await refreshClineToken(refreshToken, {
        label: acc.label ?? acc.id,
        log: log2
      });
      acc.access = next.access;
      acc.refresh = next.refresh;
      acc.expires = next.expires;
      clearAuthHealth(acc, { preserveModelLimits: true });
      if (peer) rebaseCredentials(pool, peer);
      await persistPoolFile(pool, file);
    });
  })();
  refreshFlight.set(flightKey, p);
  try {
    await p;
  } finally {
    refreshFlight.delete(flightKey);
  }
}
function quarantineAccount(pool, acc, reason, log2) {
  acc.authFailedAt = Date.now();
  acc.authFailedReason = reason;
  delete acc.limitedUntil;
  void savePoolFile(pool).catch(() => {
  });
  log2(
    "error",
    `cline-free: account ${acc.label ?? acc.id} needs re-login (${reason}). Run /connect \u2192 cline-free and log in again; rotation continues on the remaining accounts.`,
    { accountId: acc.id }
  );
}
var PROBE_INTERVAL_MS = 15 * 60 * 1e3;
async function probeQuarantinedAccounts(pool, log2) {
  const now = Date.now();
  let changed = false;
  for (const acc of trackedAccounts(pool)) {
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
          log2("info", `cline-free: account ${acc.label ?? acc.id} recovered on probe \u2014 back in rotation`, {
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
var noCredits = /* @__PURE__ */ new WeakMap();
function hasNoCredits(pool, id) {
  return noCredits.get(pool)?.has(id) ?? false;
}
function markNoCredits(pool, id, log2, detail) {
  const ids = noCredits.get(pool) ?? /* @__PURE__ */ new Set();
  ids.add(id);
  noCredits.set(pool, ids);
  const acc = findAccount(pool, id);
  log2(
    "warn",
    `cline-free: account ${acc?.label ?? id} is out of Cline credits \u2014 skipping it for paid models until OpenCode restarts${detail ? ` (${detail})` : ""}`,
    { accountId: id }
  );
}
function isAvailable(pool, a, now, model) {
  if (isPaidModel(model) && hasNoCredits(pool, a.id)) return false;
  const until = modelLimitUntil(a, model);
  if (until && until > now) return false;
  migrateLimits(a);
  return !a.limitedUntil || a.limitedUntil <= now;
}
function selectAccount(pool, now = Date.now(), model) {
  const candidates = allCandidates(pool);
  const healthy = candidates.filter((a) => isAvailable(pool, a, now, model));
  if (healthy.length === 0) return void 0;
  const key = model ?? "";
  const cursor = rrCursors.get(key) ?? 0;
  const pick = healthy[cursor % healthy.length] ?? healthy[0];
  rrCursors.set(key, (cursor + 1) % healthy.length);
  return pick;
}
var sessionPins = /* @__PURE__ */ new WeakMap();
var MAX_PINS = 1e3;
var pinKey = (sessionID, model) => `${sessionID}\0${model ?? ""}`;
function pinnedAccountId(pool, sessionID, model) {
  return sessionPins.get(pool)?.get(pinKey(sessionID, model));
}
function pinSession(pool, sessionID, model, accountId) {
  let pins = sessionPins.get(pool);
  if (!pins) {
    pins = /* @__PURE__ */ new Map();
    sessionPins.set(pool, pins);
  }
  const key = pinKey(sessionID, model);
  pins.delete(key);
  pins.set(key, accountId);
  while (pins.size > MAX_PINS) pins.delete(pins.keys().next().value);
}
function selectAccountForSession(pool, now, model, sessionID) {
  if (!sessionID) return selectAccount(pool, now, model);
  const pinned = pinnedAccountId(pool, sessionID, model);
  if (pinned) {
    const acc = allCandidates(pool).find((a) => a.id === pinned);
    if (acc && isAvailable(pool, acc, now, model)) return acc;
  }
  const next = selectAccount(pool, now, model);
  if (next) pinSession(pool, sessionID, model, next.id);
  return next;
}
function markAccountLimited(pool, id, retryAfterMs, log2, detail, model) {
  const acc = findAccount(pool, id);
  const until = Date.now() + (retryAfterMs ?? nextUtcMidnightMs() - Date.now());
  const name = acc?.label ?? id;
  if (acc) {
    migrateLimits(acc);
    if (model) {
      acc.modelLimits ??= {};
      acc.modelLimits[model] = until;
    } else {
      acc.limitedUntil = Math.max(acc.limitedUntil ?? 0, until);
    }
    acc.lastError = `429${detail ? `: ${detail}` : ""}`;
  }
  log2(
    "warn",
    `cline-free: account ${name} hit 429${model ? ` on ${model}` : ""} \u2014 cooling down until ${new Date(until).toISOString()}${detail ? ` (${detail})` : ""}`,
    { accountId: id, limitedUntil: until }
  );
  void savePoolFile(pool).catch(() => {
  });
}
function describeLimits(pool) {
  const limited = pool.accounts.filter((a) => cooldownUntil(a) > Date.now());
  if (limited.length === 0) return "";
  return ` Limited: ${limited.map((a) => `${a.label ?? a.id}\u2192${new Date(cooldownUntil(a)).toISOString()}`).join(", ")}.`;
}

// src/core/modelList.ts
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
async function refreshAndCache(timeoutMs, log2) {
  const live = await fetchLiveFreeModels(timeoutMs);
  if (!live) return void 0;
  const entries = withExtraModels(live);
  const meta = await fetchCatalogMetadata(
    entries.map((e) => e.id),
    timeoutMs
  ).catch(() => ({}));
  await writeModelsCache(live, meta).catch(
    (e) => log2?.("warn", `cline-free: could not save model cache: ${e instanceof Error ? e.message : String(e)}`)
  );
  return { entries, meta };
}
async function loadFreeModels(log2, timeoutMs = 12e3) {
  const cached = await readModelsCache();
  if (cached) {
    const refreshed = refreshAndCache(timeoutMs, log2).catch(() => void 0);
    return { entries: withExtraModels(cached.entries), meta: cached.meta, source: "cache", refreshed };
  }
  const live = await refreshAndCache(timeoutMs, log2).catch(() => void 0);
  if (live) return { ...live, source: "live", refreshed: Promise.resolve(void 0) };
  return { entries: withExtraModels(FALLBACK_FREE), meta: {}, source: "fallback", refreshed: Promise.resolve(void 0) };
}

// src/core/account.ts
function mergeNativeAuth(pool, auth) {
  const a = auth;
  if (a?.type === "api" && typeof a.key === "string" && a.key.trim()) {
    const snapshot = JSON.stringify(pool.accounts);
    upsertApiAccount(pool, String(a.key), void 0);
    if (JSON.stringify(pool.accounts) !== snapshot) void savePoolFile(pool).catch(() => {
    });
  } else if (a?.type === "oauth" && typeof a.access === "string") {
    const snapshot = JSON.stringify(pool.accounts);
    const acc = upsertOAuthAccount(
      pool,
      { access: String(a.access), refresh: String(a.refresh ?? ""), expires: Number(a.expires ?? 0) },
      typeof a.accountId === "string" ? a.accountId : void 0
    );
    if ((!acc.label || acc.label === a.accountId) && isGenericLabel(acc.label)) {
      const knownEmail = normalizeEmailLabel(typeof a.accountId === "string" ? a.accountId : void 0) ?? payloadEmail(String(a.access));
      if (knownEmail) {
        acc.label = knownEmail;
        void savePoolFile(pool).catch(() => {
        });
      } else {
        void fetchUserEmail(String(a.access)).then((email) => {
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
}
async function resolveActiveToken(pool, log2, opts = {}) {
  let picked = selectAccountForSession(pool, Date.now(), opts.model, opts.sessionID);
  if (!picked && trackedAccounts(pool).some((a) => a.authFailedAt)) {
    await probeQuarantinedAccounts(pool, log2);
    picked = selectAccountForSession(pool, Date.now(), opts.model, opts.sessionID);
  }
  if (!picked) {
    const candidates = allCandidates(pool);
    if (candidates.length === 0) return void 0;
    const resetOf = (a) => cooldownUntil(a, opts.model);
    const earliest = [...candidates].sort((a, b) => resetOf(a) - resetOf(b))[0];
    const t = tokenOf(earliest);
    if (!t) return void 0;
    log2("warn", `cline-free: all accounts cooling down \u2014 next reset ${new Date(resetOf(earliest) || Date.now()).toISOString()}${describeLimits(pool)}`);
    return t;
  }
  const useFallback = (exceptId) => {
    const fb = selectAccount(pool, Date.now(), opts.model);
    const ft = fb ? tokenOf(fb) : void 0;
    if (fb && ft && fb.id !== exceptId) {
      pool.activeId = fb.id;
      fb.lastUsed = Date.now();
      if (opts.sessionID) pinSession(pool, opts.sessionID, opts.model, fb.id);
      void savePoolFile(pool).catch(() => {
      });
      return ft;
    }
    return void 0;
  };
  const needsRefresh = !!picked.access && typeof picked.expires === "number" && picked.expires - Date.now() < REFRESH_BUFFER_MS;
  if (needsRefresh && !picked.refresh) {
    quarantineAccount(pool, picked, "access token expired and no refresh token is stored", log2);
    const fb = useFallback(picked.id);
    if (fb) return fb;
  } else if (needsRefresh) {
    try {
      await refreshAccount(pool, picked, log2);
      await opts.onRefreshed?.(picked);
    } catch (e) {
      if (e instanceof TerminalAuthError) {
        quarantineAccount(pool, picked, e.message, log2);
      } else {
        log2("warn", `cline-free: token refresh failed for ${picked.label ?? picked.id}: ${e instanceof Error ? e.message : String(e)} \u2014 trying next account`, { accountId: picked.id });
        picked.lastError = "refresh failed";
        void savePoolFile(pool).catch(() => {
        });
      }
      const fb = useFallback(picked.id);
      if (fb) return fb;
    }
  }
  const token = tokenOf(picked);
  if (!token) return void 0;
  pool.activeId = picked.id;
  picked.lastUsed = Date.now();
  return token;
}
var oauthOwner = (pool, access) => pool.accounts.find((a) => {
  const t = tokenOf(a);
  return !!t && sameAccount(t, access);
});
var mergedKeys = /* @__PURE__ */ new WeakMap();
function mergeConnectionCredential(pool, credential) {
  if (credential?.type === "key" && "key" in credential) {
    const key = typeof credential.key === "string" ? credential.key.trim() : "";
    if (!key || isRemoved(pool, key)) return;
    const seen = mergedKeys.get(pool) ?? /* @__PURE__ */ new Set();
    mergedKeys.set(pool, seen);
    const raw = stripWorkOSPrefix(key);
    if (seen.has(raw)) return;
    seen.add(raw);
    if (pool.accounts.some((a) => tokenOf(a) && stripWorkOSPrefix(tokenOf(a)) === raw)) return;
    const owner2 = findOAuthDuplicate(pool, key);
    if (owner2 && !owner2.authFailedAt) return;
    mergeNativeAuth(pool, { type: "api", key });
    return;
  }
  if (credential?.type !== "oauth" || !("access" in credential)) return;
  if (isRemoved(pool, credential.access)) return;
  const owner = oauthOwner(pool, credential.access);
  if (owner && (owner.expires ?? 0) >= credential.expires) return;
  const email = credential.metadata?.email;
  mergeNativeAuth(pool, {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    accountId: typeof email === "string" ? email : void 0
  });
}
async function refreshViaPool(pool, credential, log2) {
  const owner = oauthOwner(pool, credential.access);
  if (!owner && isRemoved(pool, credential.access)) {
    throw new TerminalAuthError(
      "this Cline account was removed with cline_free_remove \u2014 disconnect it in /connect, or log in again to bring it back"
    );
  }
  const acc = owner ?? upsertOAuthAccount(pool, credential);
  const fresh = typeof acc.expires === "number" && acc.expires - Date.now() >= REFRESH_BUFFER_MS;
  if (!fresh) await refreshAccount(pool, acc, log2);
  const access = tokenOf(acc);
  if (!access || !acc.refresh || typeof acc.expires !== "number") {
    throw new TerminalAuthError(`account ${acc.label ?? acc.id} has no usable session \u2014 re-login required`);
  }
  return { access, refresh: acc.refresh, expires: acc.expires };
}
function tidyPool(pool) {
  const pruned = pruneLimits(pool);
  const deduped = dedupePool(pool);
  if (pruned || deduped) void savePoolFile(pool).catch(() => {
  });
}

// src/core/tools.ts
var TOOL_DESCRIPTIONS = {
  status: "Show Cline Free account pool status: stored accounts, env accounts, which is active, 429 cooldowns, and accounts out of Cline credits.",
  remove: "Remove a stored Cline Free account from the rotation pool by id (see cline_free_status). Env accounts cannot be removed here \u2014 unset the env var instead.",
  addToken: "Validate and add a Cline token (workos:... or raw) to the rotation pool."
};
function poolStatusText(pool) {
  pruneLimits(pool);
  if (dedupePool(pool)) void savePoolFile(pool).catch(() => {
  });
  const candidates = allCandidates(pool);
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
      hasNoCredits(pool, a.id) ? "NO-CREDITS (paid models skipped until restart)" : "",
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
async function removeAccount(pool, id, log2) {
  const idx = pool.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return `No stored account with id ${id}.`;
  const [removed] = pool.accounts.splice(idx, 1);
  if (pool.activeId === id) delete pool.activeId;
  const token = tokenOf(removed);
  if (token) rememberRemoval(pool, token);
  await savePoolFile(pool).catch(() => {
  });
  log2("info", `cline-free: removed account ${removed.label ?? removed.id}`, { accountId: id });
  return `Removed ${removed.label ?? removed.id} (${pool.accounts.length} stored left). If it is also connected in /connect, disconnect it there too; until then the plugin ignores that connection. Logging in again with the same account brings it back.`;
}
async function addToken(pool, token, label, log2) {
  const key = token?.trim();
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
  forgetRemoval(pool, key);
  const acc = upsertApiAccount(pool, key, label?.trim() || email);
  if (label?.trim()) acc.label = label.trim();
  else if (email) acc.label = email;
  await savePoolFile(pool).catch(() => {
  });
  log2("info", `cline-free: added token ${acc.label ?? acc.id} (${pool.accounts.length} total)`, { accountId: acc.id });
  return `Added ${acc.label ?? acc.id} [${acc.id}] (${pool.accounts.length} stored total).`;
}

// src/core/router.ts
var RETRY_HEADERS_TIMEOUT_MS = 12e4;
function createRoutedFetch(pool, log2, baseFetch = (input, init) => globalThis.fetch(input, init), opts = {}) {
  const origFetch = baseFetch;
  return (async (input, init) => {
    let url;
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input?.url === "string" ? input.url : "";
    } catch {
      return origFetch(input, init);
    }
    if (!isRoutableUrl(url)) return origFetch(input, init);
    if (init?.body instanceof ReadableStream) return origFetch(input, init);
    const request = new Request(input, init);
    const method = request.method;
    const headers = new Headers(request.headers);
    const signal = request.signal;
    signal.throwIfAborted();
    let body = null;
    if (request.body) {
      const reader = request.body.getReader();
      let onAbort = () => {
      };
      const aborted = new Promise((_, reject) => {
        onAbort = () => {
          reject(signal.reason);
          void reader.cancel(signal.reason).catch(() => {
          });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        body = await Promise.race([
          (async () => {
            try {
              const chunks = [];
              let length = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                length += value.byteLength;
              }
              const bytes = new Uint8Array(length);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return bytes.buffer;
            } finally {
              reader.releaseLock();
            }
          })(),
          aborted
        ]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    signal.throwIfAborted();
    const replayInit = {
      ...init,
      method,
      headers,
      body,
      signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy
    };
    const incomingAuth = headers.get("authorization") ?? "";
    const incomingToken = incomingAuth.replace(/^bearer\s+/i, "");
    const now = Date.now();
    const reqModel = modelOfRequest(url, body);
    const paid = isPaidModel(reqModel);
    pruneLimits(pool, now);
    const firstOwner = incomingToken ? findByToken(pool, incomingToken) : void 0;
    const first = firstOwner ? { token: incomingToken, accountId: firstOwner.id } : void 0;
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
    const outOfCredits = (res) => paid && res.status === 402;
    const parkNoCredits = async (res, id) => {
      const detail = cleanDetail(await readSnippet(res));
      lastRes = keepForReturn(res);
      await drain(res).catch(() => {
      });
      markNoCredits(pool, id, log2, detail);
    };
    const served = (id) => {
      if (!id) return;
      pool.activeId = id;
      const acc = findAccount(pool, id);
      if (acc) {
        acc.lastUsed = Date.now();
        void savePoolFile(pool).catch(() => {
        });
      }
      if (opts.sessionID) pinSession(pool, opts.sessionID, reqModel, id);
    };
    let sends = 0;
    const send = async (token) => {
      signal.throwIfAborted();
      const h = new Headers(headers);
      if (token) h.set("authorization", `Bearer ${withWorkOSPrefix(token)}`);
      const sendInit = { ...replayInit, headers: h, body: body?.slice(0) ?? null };
      if (sends++ === 0) return origFetch(url, sendInit);
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(new Error(`cline-free: retry got no response within ${RETRY_HEADERS_TIMEOUT_MS / 1e3}s`)),
        RETRY_HEADERS_TIMEOUT_MS
      );
      try {
        return await origFetch(url, { ...sendInit, signal: AbortSignal.any([signal, ctrl.signal]) });
      } finally {
        clearTimeout(timer);
      }
    };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let token;
      let accountId;
      const firstAcc = first ? findAccount(pool, first.accountId) : void 0;
      const firstLimited = firstAcc ? !isAvailable(pool, firstAcc, now, reqModel) || !!firstAcc.authFailedAt : false;
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
      const res = await send(token);
      if (res.status === 401 || res.status === 403) {
        const snippet2 = await readSnippet(res);
        if (!isAuthFailure(res.status, snippet2)) {
          served(accountId);
          return res;
        }
        const detail2 = cleanDetail(snippet2);
        let acc = findAccount(pool, accountId);
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
            log2(
              "info",
              `cline-free: stale cached token (${maskToken(token)}) matched to ${owner.label ?? owner.id} by user key \u2014 replaying with its current session`
            );
          }
        }
        if (staleCache && acc) {
          const res2 = await send(tokenOf(acc));
          if (outOfCredits(res2)) {
            await drain(res).catch(() => {
            });
            await parkNoCredits(res2, acc.id);
            continue;
          }
          if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
            served(acc.id);
            log2(
              "info",
              `cline-free: request recovered on ${acc.label ?? acc.id} with its current session (stale cached token)`
            );
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
            markAccountLimited(
              pool,
              acc.id,
              parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail22),
              log2,
              detail22,
              reqModel
            );
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
            await refreshAccount(pool, acc, log2);
            const fresh = tokenOf(acc);
            if (fresh) {
              const res2 = await send(fresh);
              if (outOfCredits(res2)) {
                await drain(res).catch(() => {
                });
                await parkNoCredits(res2, acc.id);
                continue;
              }
              if (res2.status !== 401 && res2.status !== 403 && res2.status !== 429) {
                served(acc.id);
                if (attempt > 0)
                  log2(
                    "info",
                    `cline-free: request recovered on ${acc.label ?? acc.id} after re-auth (attempt ${attempt + 1})`
                  );
                else log2("info", `cline-free: request recovered on ${acc.label ?? acc.id} after silent refresh`);
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
                markAccountLimited(
                  pool,
                  acc.id,
                  parseRetryAfterMs(res2) ?? parseRetryAfterFromBody(detail22),
                  log2,
                  detail22,
                  reqModel
                );
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
                log2
              );
              continue;
            }
          } catch (e) {
            lastAuthRes = keepForReturn(res);
            await drain(res).catch(() => {
            });
            if (e instanceof TerminalAuthError) {
              quarantineAccount(pool, acc, e.message, log2);
            } else {
              log2(
                "warn",
                `cline-free: token refresh failed for ${acc.label ?? acc.id}: ${e instanceof Error ? e.message : String(e)} \u2014 trying next account`,
                { accountId: acc.id }
              );
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
          quarantineAccount(pool, acc, `Cline returned HTTP ${res.status}${detail2 ? `: ${detail2}` : ""}`, log2);
        } else {
          log2("warn", `cline-free: 401/403 on untracked identity (${maskToken(token)})${detail2 ? ` \u2014 ${detail2}` : ""}`);
          return res;
        }
        continue;
      }
      if (outOfCredits(res) && accountId && findAccount(pool, accountId)) {
        await parkNoCredits(res, accountId);
        continue;
      }
      if (res.status !== 429) {
        served(accountId);
        if (attempt > 0)
          log2(
            "info",
            `cline-free: request recovered on ${findAccount(pool, accountId)?.label ?? "fallback account"} after 429/402/re-auth (attempt ${attempt + 1})`
          );
        return res;
      }
      const snippet = await readSnippet(res);
      lastRes = keepForReturn(res);
      await drain(res).catch(() => {
      });
      const retryAfter = parseRetryAfterMs(res) ?? parseRetryAfterFromBody(cleanDetail(snippet));
      const detail = cleanDetail(snippet);
      if (accountId && findAccount(pool, accountId)) {
        markAccountLimited(pool, accountId, retryAfter, log2, detail, reqModel);
      } else {
        log2("warn", `cline-free: 429 on untracked identity (${maskToken(token)})${detail ? ` \u2014 ${detail}` : ""}`);
        break;
      }
    }
    if (lastAuthRes && !lastRes) {
      const quarantined = pool.accounts.filter((a) => a.authFailedAt).map((a) => `${a.label ?? a.id}`).join(", ");
      log2(
        "error",
        `cline-free: all ${tried.size} account(s) rejected auth (401/403). ${quarantined ? `Quarantined: ${quarantined}. ` : ""}Run /connect \u2192 cline-free and log in again; rotation continues when a healthy account exists.`
      );
      return lastAuthRes;
    }
    if (lastRes && paid) {
      log2(
        "error",
        `cline-free: no account could serve paid model ${reqModel} (all ${tried.size} tried are out of Cline credits or rate limited). Add credits or another Cline account via /connect.`
      );
      return lastRes;
    }
    if (lastRes) {
      const waiting = pool.accounts.filter((a) => cooldownUntil(a) > Date.now()).map((a) => `${a.label ?? a.id}\u2192${new Date(cooldownUntil(a)).toISOString()}`).join(", ");
      log2(
        "error",
        `cline-free: all ${tried.size} account(s) hit 429 daily quota. ${waiting ? `Cooling: ${waiting}. ` : ""}Add another Cline account via /connect to keep going.`
      );
      const resetOf = (a) => cooldownUntil(a, reqModel);
      const earliest = allCandidates(pool).sort((a, b) => resetOf(a) - resetOf(b))[0];
      const t = earliest ? tokenOf(earliest) : void 0;
      if (earliest && t) return await send(t);
      return lastRes;
    }
    return send(incomingToken || void 0);
  });
}
function needsFailover(status) {
  return status === 401 || status === 402 || status === 403 || status === 429;
}
async function recoverResponse(pool, log2, request, response, baseFetch = (input, init) => globalThis.fetch(input, init), opts = {}) {
  if (!needsFailover(response.status) || !isRoutableUrl(request.url)) return response;
  const originalAuth = request.headers.get("authorization") ?? "";
  let reused = false;
  const replayFetch = (async (input, init) => {
    const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0)).get("authorization") ?? "";
    if (!reused && auth === originalAuth) {
      reused = true;
      return response;
    }
    return baseFetch(input, init);
  });
  return createRoutedFetch(pool, log2, replayFetch, opts)(request);
}

// src/v2.ts
var providerID = PROVIDER_ID;
var DEVICE_METHOD = "device";
var CLI_METHOD = "cli";
var log = (level, message, extra) => {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};
function toModelInfo(entry, auto) {
  const config = modelConfig(entry, auto);
  const id = entry.id;
  const usd = (n) => n;
  return {
    id,
    modelID: id,
    providerID,
    name: config.name,
    capabilities: { tools: config.tool_call, input: config.modalities.input, output: config.modalities.output },
    ...config.options ? { settings: { reasoningEffort: config.options.reasoningEffort } } : {},
    variants: Object.entries(config.variants ?? {}).map(([level, options]) => ({
      id: level,
      settings: { reasoningEffort: options.reasoningEffort }
    })),
    time: { released: 0 },
    cost: [
      {
        input: usd(config.cost.input),
        output: usd(config.cost.output),
        cache: { read: usd(config.cost.cache_read), write: usd(config.cost.cache_write) }
      }
    ],
    status: "active",
    enabled: true,
    limit: { context: config.limit.context, output: config.limit.output }
  };
}
function providerInput(entries, meta) {
  return {
    info: {
      id: providerID,
      integrationID: PROVIDER_ID,
      name: "Cline Free",
      // Always listed: the account pool (not V2's single credential) decides
      // which Cline account a request uses.
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: CHAT_BASE_URL },
      headers: { ...CLINE_HEADERS }
    },
    models: entries.map((entry) => toModelInfo(entry, meta[entry.id]))
  };
}
function accountLabel(email) {
  const local = email?.split("@")[0];
  if (!local) return void 0;
  return local.length > 12 ? `${local.slice(0, 11)}\u2026` : local;
}
var oauthCredential = (methodID, creds, email) => ({
  type: "oauth",
  methodID,
  access: creds.access,
  refresh: creds.refresh,
  expires: creds.expires,
  ...email ? { metadata: { email } } : {}
});
function credentialEmail(credential, pool) {
  const saved = credential.metadata?.email;
  const owner = pool?.accounts.find((a) => {
    const t = tokenOf(a);
    return !!t && sameAccount(t, credential.access);
  });
  return payloadEmail(credential.access) ?? (typeof saved === "string" && saved.includes("@") ? saved : void 0) ?? (owner ? accountEmail(owner) : void 0);
}
var objectSchema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var text = (input, key) => {
  const value = input?.[key];
  return typeof value === "string" ? value : void 0;
};
var setup = async (ctx) => {
  let disposed = false;
  const pool = await loadPoolFile();
  {
    const pruned = pruneLimits(pool);
    const deduped = dedupePool(pool);
    if (pruned || deduped) void savePoolFile(pool).catch(() => {
    });
    if (deduped) log("info", `cline-free: removed duplicate login(s) \u2014 ${pool.accounts.length} unique account(s) left`);
  }
  const seeded = allCandidates(pool).length;
  if (seeded > 0) log("info", `cline-free: ${pool.accounts.length} stored account(s) + env merged \u2192 ${seeded} rotation candidate(s)`);
  const loaded = await loadFreeModels(log);
  const models = { entries: loaded.entries, meta: loaded.meta };
  log("info", `cline-free: loaded ${models.entries.length} Cline models (${loaded.source})`);
  await ctx.provider.transform((editor) => {
    editor.add(providerInput(models.entries, models.meta));
  });
  void loaded.refreshed.then(async (latest) => {
    if (!latest || disposed) return;
    models.entries = latest.entries;
    models.meta = latest.meta;
    await ctx.provider.reload();
  }).catch(() => {
  });
  let deviceLogin;
  await ctx.integration.transform((editor) => {
    editor.update(PROVIDER_ID, (integration) => {
      integration.name = "Cline Free";
    });
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: DEVICE_METHOD, type: "oauth", label: "Cline account (free models, recommended)" },
      authorize: async () => {
        deviceLogin?.abort();
        const attempt = new AbortController();
        deviceLogin = attempt;
        const device = await startDeviceAuth();
        const callback = (async () => {
          const workos = await pollDeviceAuth(device.deviceCode, device.expiresInSeconds, device.intervalSeconds, attempt.signal);
          if (attempt.signal.aborted || disposed) throw new Error("device login was superseded by a newer login attempt");
          const creds = await registerWorkOSTokens(workos);
          const email = await fetchUserEmail(creds.access);
          if (attempt.signal.aborted || disposed) throw new Error("device login was superseded by a newer login attempt");
          forgetRemoval(pool, creds.access);
          const acc = upsertOAuthAccount(pool, creds, email, "oauth");
          if (email) acc.label = email;
          void savePoolFile(pool).catch(() => {
          });
          log("info", `cline-free: added account ${acc.label ?? acc.id} (${pool.accounts.length} total)`);
          return oauthCredential(DEVICE_METHOD, creds, email);
        })();
        callback.catch((e) => log("warn", `cline-free: device authorization failed: ${e instanceof Error ? e.message : String(e)}`));
        return {
          url: device.verificationUriComplete ?? device.verificationUri,
          instructions: `Open the URL (code ${device.userCode} is pre-filled). Already logged into Cline in this browser? Just click Confirm/Approve \u2014 no password needed. Otherwise log in with Google/GitHub/Microsoft, then approve. Then wait \u2014 OpenCode completes login automatically.`,
          expiresAt: Date.now() + device.expiresInSeconds * 1e3,
          mode: "auto",
          callback
        };
      },
      refresh: async (credential) => {
        const creds = await refreshViaPool(pool, credential, log);
        return oauthCredential(credential.methodID, creds, credentialEmail({ ...credential, access: creds.access }, pool));
      },
      label: (credential) => accountLabel(credentialEmail(credential, pool))
    });
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: CLI_METHOD, type: "oauth", label: "Reuse Cline CLI login (this machine, 1 confirm)" },
      authorize: async () => {
        const session = await readClineCliSession();
        if (!session) {
          throw new Error(
            "No Cline CLI login found on this machine (~/.cline/data/settings/providers.json). Run `cline auth` first, or pick another method."
          );
        }
        const callback = (async () => {
          let { access, refresh, expires } = session;
          if (!await validateClineToken(access)) {
            if (!refresh) throw new Error("Cline CLI session expired and has no refresh token. Run `cline auth` again.");
            const next = await refreshClineToken(refresh, { label: session.email ?? "cli-import", log });
            access = next.access;
            refresh = next.refresh;
            expires = next.expires;
            if (!await validateClineToken(access)) throw new Error("Cline rejected the refreshed CLI session.");
          }
          forgetRemoval(pool, access);
          const acc = upsertOAuthAccount(pool, { access, refresh, expires }, session.email, "cli");
          if (session.email) acc.label = session.email;
          void savePoolFile(pool).catch(() => {
          });
          log("info", `cline-free: added CLI-imported account ${acc.label ?? acc.id} (${pool.accounts.length} total)`);
          return oauthCredential(CLI_METHOD, { access, refresh, expires }, session.email);
        })();
        callback.catch((e) => log("warn", `cline-free: CLI login import failed: ${e instanceof Error ? e.message : String(e)}`));
        const who = session.email ? ` for ${session.email}` : "";
        return {
          url: "https://app.cline.bot/dashboard",
          instructions: `Found an existing Cline CLI login${who}. Connecting it to OpenCode \u2014 no browser code needed.`,
          mode: "auto",
          callback
        };
      },
      refresh: async (credential) => {
        const creds = await refreshViaPool(pool, credential, log);
        return oauthCredential(credential.methodID, creds, credentialEmail({ ...credential, access: creds.access }, pool));
      },
      label: (credential) => accountLabel(credentialEmail(credential, pool))
    });
    editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "Cline token (manual)" } });
  });
  await ctx.session.hook(
    "http.request",
    async (event) => {
      if (!isRoutableUrl(event.request.url)) return;
      tidyPool(pool);
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => void 0);
      if (connection) {
        const credential = await ctx.integration.connection.resolve(connection).catch(() => void 0);
        mergeConnectionCredential(pool, credential);
      }
      const body = await Promise.resolve().then(() => event.request.clone().arrayBuffer()).catch(() => null);
      const model = modelOfRequest(event.request.url, body);
      const token = await resolveActiveToken(pool, log, { model, sessionID: event.sessionID });
      if (token) event.request.headers.set("authorization", `Bearer ${withWorkOSPrefix(token)}`);
      event.request.headers.set("X-Task-ID", event.sessionID);
    },
    { providerID: PROVIDER_ID }
  );
  await ctx.session.hook(
    "http.response",
    async (event) => {
      event.response = await recoverResponse(pool, log, event.request, event.response, void 0, { sessionID: event.sessionID });
    },
    { providerID: PROVIDER_ID }
  );
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "cline_free_status",
      description: TOOL_DESCRIPTIONS.status,
      input: objectSchema({}, []),
      execute: async () => ({ content: poolStatusText(pool) })
    });
    editor.add({
      name: "cline_free_remove",
      description: TOOL_DESCRIPTIONS.remove,
      input: objectSchema({ id: { type: "string", description: "Account id (acc_...) from cline_free_status" } }, ["id"]),
      execute: async (input) => ({ content: await removeAccount(pool, text(input, "id") ?? "", log) })
    });
    editor.add({
      name: "cline_free_add_token",
      description: TOOL_DESCRIPTIONS.addToken,
      input: objectSchema(
        {
          token: { type: "string", description: "Cline token (workos:... or raw access token)" },
          label: { type: "string", description: "Friendly label (defaults to account email)" }
        },
        ["token"]
      ),
      execute: async (input) => ({ content: await addToken(pool, text(input, "token"), text(input, "label"), log) })
    });
  });
  return () => {
    disposed = true;
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
var plugin = { id: "cline-free", setup };
var index_default = plugin;
export {
  __clineFreeTest,
  index_default as default
};
