# Plugin and model discovery

A user installs the plugin and sees Cline Free models and reasoning choices inside OpenCode V2 without editing the plugin for each rotation.

## Sub-features

- D1: Load this checkout as a V2 plugin directory.
- D2: Register provider `cline-free`, current models and model-specific variants.
- D3: Refresh discovery from the live free list and persist a usable cache.
- D4: Start offline using the last good cache or bundled fallback.

## How to get to it (user POV)

- Configure `{"plugins":["/absolute/path/to/opencode-cline-free"]}` and restart OpenCode V2.
- Run `opencode models`, or open `/models` and filter to Cline Free; open `/variants` after selecting a model.
- Install via `opencode plugin add github:itsyasirkhandev/opencode-cline-free` or copy `dist/cline-free.js` to a plugin directory (separate install paths, not proved by loading this source checkout).
- Inspect the host's public provider/model/plugin API registries.

## Driving it with the OpenCode public API and terminal

Preconditions: skill launch completed, owned host, no credentials needed for discovery.

- **D1/D2 API:** run `"$CONTROL" --run "$RUN" doctor` then `"$CONTROL" --run "$RUN" discover`. Require an active local-source plugin, Cline Free provider, nonempty model list and the device/CLI/manual login methods in `evidence/discovery.json`. Inspect variant IDs per model.
- **D2 CLI/TUI:** in a separately owned terminal instance configured with the same isolated paths, run `opencode models --standalone`, then use `/models` and `/variants` in the TUI. Capture commands, visible Cline Free names/variants and exit status. Do not connect to the user's background service. This helper does not automate TUI dialogs; do not claim them through API proof.
- **D3:** after online discovery, inspect only the cache's `free` IDs, `fetchedAt` and existence (not credentials). Compare with a fresh GET of `https://api.cline.bot/api/v1/ai/cline/recommended-models`. Wait for background refresh before concluding a mismatch; capture both states. Record whether the source was live, cached or fallback.
- **D4:** only in an approved network-isolated disposable environment, launch with a previously saved cache, then separately with an empty cache. Require host-visible models and the expected cached/fallback source. The standard helper permits network access and does not prove offline mode. Record blocked if network isolation is unavailable.

## Gotchas

- `/api/provider` can initially be empty while plugins initialize. HTTP listening is not usable readiness; the helper waits for plugin registration.
- Paid extras are intentionally registered too. Presence under Cline Free or a $0 display alone is not proof that chat will be free.
- Free models rotate; compare actual live IDs, not a hard-coded count or dated README table. Offline fallback can be stale.
- Loading source does not verify committed bundle parity, GitHub installation, updater/remover, CLI rendering or offline behavior. Mark these separately.
