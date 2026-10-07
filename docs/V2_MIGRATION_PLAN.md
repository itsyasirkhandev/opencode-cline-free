# OpenCode V2 support plan

> Goal: one package and one default export that runs on OpenCode V1 (>= 1.18.29) **and** V2.
> V1 calls `server()`, V2 calls `setup()`. Each side uses its own API; nothing is translated automatically.
> Sources: [V2 plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1),
> [V2 plugins guide](https://opencode.ai/v2/docs/build/plugins).

## Status

| Phase | Scope | Status | Release |
| --- | --- | --- | --- |
| 1 | Split core / V1 adapter, no behaviour change | Done (PR #4) | 0.6.3 |
| 2 | Minimal V2: provider + models + one account | Later | — |
| 3 | V2 multi-account rotation + 429/401 failover | Later | — |
| 4 | V2 login methods (integration) | Later | — |
| 5 | V2 tools, cleanup, CI matrix, docs, release | Later | 0.7.0 |

## Phase 1 — done

- Moved `auth`, `constants`, `http`, `modelList`, `models`, `pool`, `router` into `src/core/` (pure moves).
- `src/core/account.ts`: `mergeNativeAuth`, `resolveActiveToken` (pick → refresh → fallback → quarantine; same logic as the old loader), `tidyPool`. The V1-only `provider.update` sync is passed in through an `onRefreshed` callback.
- `src/core/tools.ts`: `poolStatusText`, `removeAccount`, `addToken`, `TOOL_DESCRIPTIONS`.
- `src/plugin.ts` → `src/v1.ts`: thin adapter. The `config` hook and the 3 login methods stay there because they are V1-shaped.
- `test/core.test.ts` added.
- **Rule: nothing in `src/core/` may import `@opencode-ai/*` or `@opencode/*`.**

## Phase 2 — Minimal V2 adapter

Goal: on V2, models show up and one account can chat.

- [ ] Add `src/v2.ts` exporting `setupV2(ctx)`; import V2 types with `import type` only.
- [ ] Update `src/index.ts` to export `{ id: "cline-free", setup: setupV2, server: ClineFreePlugin }`. Write the object by hand: don't import `Plugin.define` at runtime, or V1 installs without the V2 package will break.
- [ ] Load the model list (`loadFreeModels`) **before** registering, then `ctx.provider.transform(editor => editor.add({ info, models }))` with the openai-compatible provider package, `settings.baseURL = CHAT_BASE_URL` and the Cline surface headers.
- [ ] Keep the transform synchronous and side-effect free. When the background refresh lands, update the captured list and call `ctx.provider.reload()`.
- [ ] Logger: map `Logger` to whatever V2 offers (fall back to `console`).
- [ ] `ctx.session.hook("http.request", …, { providerID: "cline-free" })`: call `resolveActiveToken(pool, log)` and set `Authorization: Bearer workos:…`.
- [ ] Return a cleanup function from `setup` (stop lock heartbeat / background refresh timers).
- [ ] Add the V2 plugin package as an **optional** peer (`peerDependenciesMeta`), mark it external in esbuild, and confirm the real package name (`@opencode/plugin` vs `@opencode-ai/plugin/v2`).

**Exit criteria:** on a fresh V2 install the cline-free models are listed and one chat completes; V1 unchanged (tests green).

## Phase 3 — Rotation and failover on V2 (highest risk)

V2 has no auth loader that returns a custom `fetch`, so `router.ts` can't be plugged in as-is.

- [ ] **Spike first:** fake a 429 and check whether `http.response` can re-send the request with another account and replace `event.response`, including streaming bodies.
- [ ] If it works: extract the retry/replay logic from `createRoutedFetch` into a core `failover(request, response, pool)` used by both the V1 fetch wrapper and the V2 `http.response` hook.
- [ ] Keep current rules: per-model cooldowns, refresh-once-then-quarantine on 401/403, never replay paid models (`isPaidModel`).
- [ ] If it doesn't work: cool down the account so the *next* request rotates (no same-request retry) and document it as a V2 limitation.

**Exit criteria:** a forced 429 on account A ends with the turn succeeding on account B (or the documented fallback).

## Phase 4 — Login methods on V2

- [ ] Register a `cline-free` integration via `ctx.integration.transform` + `editor.method.update`.
- [ ] Device-code login → `oauth` method (reuse `startDeviceAuth` / `pollDeviceAuth` / `registerWorkOSTokens`).
- [ ] Manual token → key method (reuse `/users/me` validation; consider a core `validateManualToken`).
- [ ] "Reuse Cline CLI login" → `command` method or a tool, depending on what V2 allows.
- [ ] Store accounts in the **same pool file** (not `ctx.storage`) so accounts carry over between V1 and V2.
- [ ] Merge V2's active connection into the pool via `ctx.integration.connection.active/resolve` + `mergeNativeAuth`.

**Exit criteria:** all three login paths add an account on V2; an account added on V1 works on V2 without logging in again.

## Phase 5 — Tools, CI, docs, release

- [ ] Tools via `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, execute }))` returning `{ content: … }` from the core tool functions.
- [ ] CI matrix: OpenCode 1.18.29, latest 1.x, latest 2.x (separate jobs; both use the `opencode` binary). Test the `npm pack` tarball, not the linked repo.
- [ ] Manual checklist per version: plugin ID listed, models listed, chat works, 429 failover, token refresh persists, 3 tools, reload/unload cleans up.
- [ ] README: V1 `"plugin": [...]` vs V2 `"plugins": [...]`, minimum V1 = 1.18.29 (older V1 → pin 0.6.x), any V2 limitations.
- [ ] Update `opencode.example.json`; release **0.7.0**.

## Risks and open questions

- Same-request failover on V2 (Phase 3 spike decides).
- V2 plugin package name, and whether `Plugin.define` adds required fields beyond `id` / `setup`.
- Whether a V2 integration can run a custom device-code callback, or only built-in OAuth.
- `package-lock.json` still says version 0.5.10 (stale before Phase 1); regenerate with `npm install`.
