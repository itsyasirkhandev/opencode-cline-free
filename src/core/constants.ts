export const PROVIDER_ID = "cline-free"
export const API_BASE = "https://api.cline.bot"
export const CHAT_BASE_URL = `${API_BASE}/api/v1`
export const RECOMMENDED_URL = `${API_BASE}/api/v1/ai/cline/recommended-models`

// Public WorkOS client id used by Cline's own OAuth flows
// (same value the Pi `pi-cline` extension uses).
export const WORKOS_API = "https://api.workos.com"
export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"
export const WORKOS_PREFIX = "workos:"
export const REFRESH_BUFFER_MS = 5 * 60 * 1000

// --- Multi-account pool ---
// OpenCode stores a single Auth per provider id, so extra Cline accounts
// live in a plugin-managed pool file next to auth.json
// (~/.local/share/opencode/cline-free-accounts.json). The loader picks the
// next healthy account and a fetch wrapper retries the SAME request on a
// different account when Cline answers 429.
export const ACCOUNTS_FILE_NAME = "cline-free-accounts.json"
export const DAY_MS = 24 * 60 * 60 * 1000
