# opencode-cline-free

Use Cline's rotating **free models** inside OpenCode with your Cline account —
same quota you see tagged `FREE` in Cline VSCode/CLI.

Live source: `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`
(`free` array). The plugin fetches it on every startup, so rotations appear
automatically. Offline it falls back to a bundled list.

Current free rotation (2026-09-15):

| Model id | Notes |
|---|---|
| `cline-free/deepseek-v4.1-flash` | Cline-only free, native text+image input, 1M ctx / 384K out | low, high, max (no medium) |
| `cline-free/muse-spark-1.3-contributor` | Cline-only free | low, medium, high (`max` fails server-side) |
| `z-ai/glm-5.3-flash` | also on Zen | low, high, max |
| `cline-free/solar-pro4` | Cline-only free | low, medium, high, max |
| `poolside/laguna-s-2.1:free` | also on Zen | vendor off/max only, max default (no variants) |

Rotated out: `deepseek/deepseek-v4-flash`, `cline-free/longcat-2.0`
(previous rotation; ids kept in the plugin as known/stale).

So if `glm-5.3-flash` + `laguna` already work for you via Zen, this plugin
adds the other 3.

## Install (local)

```bash
# global
mkdir -p ~/.config/opencode/plugins
cp code/opencode-cline-free/index.ts ~/.config/opencode/plugins/cline-free.ts

# or project-level
mkdir -p .opencode/plugins
cp code/opencode-cline-free/index.ts .opencode/plugins/cline-free.ts
```

Restart OpenCode.

## Login

```text
/connect
# pick "cline-free", then one of:
# 1. Reuse Cline CLI login (this machine, 1 confirm)  <- fastest if `cline auth` was run here
# 2. Cline account (free models, recommended)         <- browser device-code flow
# 3. Cline token (manual)                             <- paste a workos:... token
```

Already logged into Cline in your browser? Method 2 is then a single
Confirm/Approve click: the login URL has your code pre-filled, so with an
active Cline browser session there's no password and no code to type —
just approve and OpenCode finishes automatically. (A terminal can't read
browser cookies, so that one click is the minimum the OAuth flow allows.)

1 confirm? If this machine already has a Cline CLI login
(`~/.cline/data/settings/providers.json`, honors `CLINE_DATA_DIR`/`CLINE_DIR`),
method 1 imports its OAuth tokens directly — the account email is shown,
you just confirm, no browser code. Expired tokens are refreshed automatically.

Manual alternative: `/connect` -> `cline-free` -> `Cline token (manual)` and
paste a `workos:...` token, or set:

```bash
export CLINE_API_KEY="workos:..."
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
> `cline-free/...` ids are Cline-native free ids; `z-ai/...`,
> `poolside/...:free` ride Cline usage-billing at $0.
> The previous `deepseek/deepseek-v4-flash` id (`cline-free/deepseek/deepseek-v4-flash`)
> has rotated out of the free list.

## Publish to npm (optional)

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
- `auth` hook implements Cline's WorkOS device-code OAuth
  (same flow as Pi's `pi-cline` extension) + manual token entry,
  refreshes via `/api/v1/auth/refresh`, and sends
  `Authorization: Bearer workos:...`.
- Free quota is per Cline account and rotating/limited — when Cline rotates,
  restart OpenCode to refresh the list.

## Caveats

- Cline docs say free models are officially for IDE Extension/CLI; this
  reuses the same account API + OAuth the community Pi extensions use.
  If Cline returns `403`, re-login (`/connect`), and check your free quota
  in the Cline dashboard.
- The WorkOS client id is Cline's public OAuth client (same as Pi extension).
