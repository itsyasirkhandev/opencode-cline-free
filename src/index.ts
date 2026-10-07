/**
 * opencode-cline-free
 *
 * Exposes Cline's rotating free models inside OpenCode through your
 * Cline account (same account/quota you see in Cline VSCode/CLI).
 *
 * Live list: GET https://api.cline.bot/api/v1/ai/cline/recommended-models
 * As of 2026-10-06 the `free` array is:
 * - cline-free/mimo-v2.6-flash
 * - cline-free/muse-spark-1.3-contributor
 * Always registered even though absent from the live `free` array:
 * z-ai/glm-5.3-flash — NOT free. It bills Cline credits (verified 2026-09-24:
 * the account balance drops by `creditsUsed`, unlike the free rotation which
 * records 0).
 * Rotated out (kept as known/stale ids where useful): cline-free/deepseek-v4.1-flash,
 * stealth/space-bunny-alpha, stealth/pixel-canary,
 * cline-free/gemini-3.8-flash, stealth/union-alpha, cline-free/solar-pro4,
 * poolside/laguna-s-2.1:free, deepseek/deepseek-v4-flash.
 */
import { ClineFreePlugin } from "./v1.ts"
import { classifyHttpFailure, fetchWithTimeout, parseOAuthErrorCode, TerminalAuthError, TransientAuthError, withTransientRetries, withWorkOSPrefix } from "./core/http.ts"
import { refreshClineToken, refreshClineTokenOnce } from "./core/auth.ts"
import { dedupePool, loadPoolFile, quarantineAccount, refreshAccount, savePoolFile } from "./core/pool.ts"

// Test seam (no runtime effect on the plugin): lets harness scripts
// exercise the auth plumbing with a mocked transport.
export const __clineFreeTest = {
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
  savePoolFile,
}

export default {
  id: "cline-free",
  server: ClineFreePlugin,
}
