# opencode-cline-free

**v0.5.6** · Use Cline's rotating **free models** inside OpenCode with your Cline account —
same quota you see tagged `FREE` in Cline VSCode/CLI.

Live source: `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`
(`free` array). The plugin fetches it on every startup, so rotations appear
automatically. Offline it falls back to a bundled list.

## Current free rotation (checked 2026-09-24)

| Model id | Notes |
|---|---|
| `stealth/space-bunny-alpha` | stealth preview (vendor anonymous), 1M context · minimal, low, medium, high, xhigh, max |
| `cline-free/mimo-v2.6-flash` | Cline-only free, MiMo 2.6 (309B MoE) · none, minimal, low, medium, high, xhigh, max (only `none` changes output) |
| `cline-free/deepseek-v4.1-flash` | Cline-only free, native text+image input, 1M ctx / 384K out · none, minimal, low, medium, high, xhigh, max |
| `cline-free/muse-spark-1.3-contributor` | Cline-only free · minimal, low, medium, high, xhigh (`max` fails server-side) |

Rotated out of the free list (ids kept in the plugin as known/stale where useful):

- `stealth/union-alpha` → replaced by `stealth/space-bunny-alpha`
- `z-ai/glm-5.3-flash`, `cline-free/solar-pro4`, `poolside/laguna-s-2.1:free`
- `deepseek/deepseek-v4-flash`

Restart OpenCode after a Cline rotation so the live list refreshes.

## Install (local)

```bash
git clone https://github.com/itsyasirkhandev/opencode-cline-free.git
cd opencode-cline-free

# global
mkdir -p ~/.config/opencode/plugins
cp index.ts ~/.config/opencode/plugins/cline-free.ts

# or project-level
mkdir -p .opencode/plugins
cp index.ts .opencode/plugins/cline-free.ts
```

Restart OpenCode.

## Login

```text
/connect
# pick "cline-free", then one of:
# 1. Cline account (free models, recommended)         <- browser device-code flow
# 2. Reuse Cline CLI login (this machine, 1 confirm)  <- fastest if `cline auth` was run here
# 3. Cline token (manual)                             <- paste a workos:... token
```

Repeat `/connect` → `cline-free` for every extra Cline account: new users
join the rotation pool (re-logging the same user updates it in place).

## Multiple accounts + 429 failover

Free quota is per Cline account and resets daily. The plugin keeps a pool
(`~/.local/share/opencode/cline-free-accounts.json`, override with
`CLINE_FREE_ACCOUNTS_FILE`) and rotates across it:

- **Loader** picks the next healthy account round-robin per request
  (limited accounts are skipped).
- **Per-model cooldowns**: Cline's free caps are per user **and** model, so an
  account exhausted on deepseek still has muse quota (and vice versa).
  `429` bodies like `Try again in 1h 37m` are parsed to match the server.
- **Fetch router**: if Cline answers `429` on a chat request, that account
  is parked until it recovers (`Retry-After` when the server sends one,
  otherwise next UTC midnight for the daily reset) and the **same request
  is retried** on the next account — the turn doesn't fail.
  `401/403` auth rejections (`Unauthorized: ... re-authenticate ...`)
  get the same treatment: the dead account is refreshed once in place and
  replayed, otherwise it is quarantined (`NEEDS-RELOGIN` in
  `cline_free_status`) and the same request is retried on the next healthy
  account. Stale cached tokens are recovered by JWT user key after rotation.
  Only non-auth `403/5xx` pass through untouched so real permission
  problems and outages stay visible.
- Cooldowns persist in the pool file, so they survive restarts.

Add accounts three ways (they merge, deduped by stable Cline user identity
— not raw token — so re-login never creates duplicates):

1. `/connect` → `cline-free` repeatedly (device flow / CLI import / manual).
2. Env vars: `CLINE_API_KEY` / `CLINE_FREE_API_KEY`, lists via
   `CLINE_API_KEYS` / `CLINE_FREE_API_KEYS` (comma/space/newline separated),
   or numbered `CLINE_API_KEY_2` … `CLINE_API_KEY_10`
   (same with `CLINE_FREE_` prefix). Env accounts are ephemeral —
   unset the var to drop them.
3. Agent tools: `cline_free_status` (list accounts, active marker,
   cooldowns), `cline_free_add_token` (validate + add a token),
   `cline_free_remove` (drop a stored account by id).

Already logged into Cline in your browser? Method 1 is then a single
Confirm/Approve click: the login URL has your code pre-filled, so with an
active Cline browser session there's no password and no code to type —
just approve and OpenCode finishes automatically. (A terminal can't read
browser cookies, so that one click is the minimum the OAuth flow allows.)

Skip the browser? If this machine already has a Cline CLI login
(`~/.cline/data/settings/providers.json`, honors `CLINE_DATA_DIR`/`CLINE_DIR`),
method 2 imports its OAuth tokens directly — the account email is shown,
you just confirm, no browser code. Expired tokens are refreshed automatically.

Manual alternative: `/connect` → `cline-free` → `Cline token (manual)` and
paste a `workos:...` token, or set:

```bash
export CLINE_API_KEY="workos:..."
# extra accounts for rotation:
export CLINE_API_KEY_2="workos:..."
export CLINE_FREE_API_KEYS="workos:...,workos:..."
```

## Use

```text
/models
# pick cline-free / <model>
```

or in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "cline-free/cline-free/deepseek-v4.1-flash"
}
```

> Note: model ids contain a `/` themselves (e.g. `cline-free/deepseek-v4.1-flash`),
> so the full spec is `cline-free/cline-free/deepseek-v4.1-flash`.
> `cline-free/...` ids are Cline-native free ids; stealth ids ride the same
> free quota at $0.
> Stale ids (`deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, etc.) may
> still be in an old config after Cline rotates them out.

See `opencode.example.json` for a minimal config snippet.

## Publish to npm (optional)

Not published yet. When ready:

```bash
npm publish --access public
# then in opencode.json: { "plugin": ["opencode-cline-free"] }
```

## How it works

- `config` hook injects provider `cline-free`
  (`@ai-sdk/openai-compatible`, `baseURL https://api.cline.bot/api/v1`)
  plus the live `free` models at $0 cost.
  (Config-hook injection is used because OpenCode currently skips
  `provider.models` hooks for non-models.dev providers.)
  User-declared models in `opencode.json` always win; the plugin only adds
  missing free ids.
- **Cline product surface headers** (v0.5.4+): chat requests mirror the
  official client identity (`User-Agent: Cline/4.1.16`, `X-CLIENT-TYPE:
  VSCode Extension`, `X-CLIENT-VERSION`, `X-CORE-VERSION`, `X-PLATFORM*`,
  `X-IS-MULTIROOT`, `X-Title: Cline`). The gateway serves native free models
  only to Cline product surfaces; without them it answers
  `403 only available via Cline product surfaces`
  ([cline/cline#13593](https://github.com/cline/cline/issues/13593)).
  Verified 2026-09-21 against the live API.
- `auth` hook implements Cline's WorkOS device-code OAuth
  (same flow as Pi's `pi-cline` extension) + manual token entry,
  refreshes via `/api/v1/auth/refresh`, and sends
  `Authorization: Bearer workos:...`.
  Refresh is single-flight per account (concurrent requests share one
  refresh so rotation is never mistaken for token replay), transient
  failures retry with backoff while `invalid_grant` quarantines the
  account for re-login (visible as `NEEDS-RELOGIN` in
  `cline_free_status`), pool writes are atomic, and every
  token-endpoint call has a timeout.
- Free quota is per Cline account and rotating/limited — when Cline rotates,
  restart OpenCode to refresh the list.

## Changelog (high level)

| Version | Changes |
|---|---|
| **0.5.6** | Match per-model reasoning variants to the exact set the Cline gateway accepts (live-probed: added `xhigh`/`minimal`/`none` where accepted, dropped nothing valid) |
| 0.5.5 | Refresh bundled free list + metadata for the 2026-09-24 rotation (space-bunny-alpha, mimo-v2.6-flash) |
| 0.5.4 | Send Cline product surface headers — fixes `403 only available via Cline product surfaces` on native free models |
| 0.5.x | `stealth/union-alpha` in free rotation + reasoning variants (low/medium/high/xhigh, medium default) |
| — | Per-model 429 cooldowns; API-key accounts kept separate from OAuth |
| — | Transparent 401/403 auth recovery (refresh + failover); stale cached token recovery by JWT user key |
| — | Production-grade OAuth: single-flight refresh, error classification, quarantine, atomic pool writes |
| — | Multi-account pool with automatic 429 failover; same-user logins deduped by stable Cline identity |
| — | Live free-model list, per-model reasoning variants, vendor-correct limits/cost display ($0) |

## Caveats

- Cline docs say free models are officially for IDE Extension/CLI. This
  plugin reuses the same account API + OAuth the community Pi extensions
  use, and **impersonates the official client surface headers** so the
  gateway accepts native free ids. If Cline still returns `403`, re-login
  (`/connect`) and check your free quota in the Cline dashboard.
- The WorkOS client id is Cline's public OAuth client (same as Pi extension).
- Free list rotates without notice — trust the live endpoint over any
  table in this README.
