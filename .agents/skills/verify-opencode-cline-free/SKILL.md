---
name: verify-opencode-cline-free
description: Verify the opencode-cline-free plugin in a real OpenCode V2 host through its public API, with separate CLI/TUI journeys for login, model selection, chat, accounts and failover. Use after plugin changes or when investigating runtime behavior; preserve redacted evidence and distinguish live proof from regression tests.
---

# Verify opencode-cline-free

Read `features/README.md`, then the feature being verified. If the agent does not discover `.agents/skills/`, load this file explicitly; resolve links relative to this directory. Use the active agent's terminal tools, not a vendor-specific agent or task API.

## Boundaries

- Verify the actual checkout inside **OpenCode V2**, not OpenCode 1.x or a fake plugin context. The primary surface is the OpenCode host (CLI/TUI and public API); the marketing site is out of scope.
- Ask before installation, launching/building, network access or publishing when project/user rules require it. Ask the user to authorize the Cline device flow before authenticated proof. Never request tokens in chat.
- Use a fresh disposable project, HOME, XDG directories, account pool and model cache. Do not import the user's real CLI login or account pool. The helper allowlists environment variables so ambient provider credentials are not inherited.
- Do not use paid models, intentionally consume an account's quota, invalidate real credentials, or edit pool state to manufacture live proof. A live free allowlist is required for chat; offline fallback is not a billing guarantee.
- Public host API operations are a real user entry point, but do not prove terminal dialogs. Report each CLI/TUI entry point separately. Never substitute `__clineFreeTest`, direct hook calls, or a passing test suite for host behavior.

## Launch

From the repository root, inspect project instructions, `README.md`, `package.json` and existing changes first. Do not repair product code without authorization. Do not launch against a broken base.

The repository has `package-lock.json`; its locked `@opencode/plugin` is 2.0.26. An unlocked install selected plugin 2.1.0 with an unavailable schema dependency during the initial verification. Preserve locked versions rather than silently upgrading. Using pnpm on a clean checkout:

```sh
pnpm import
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

`pnpm import` creates a temporary `pnpm-lock.yaml`; remember whether this run created it and remove only that untracked generated file during cleanup. Do not commit a lockfile migration. The repository's documented npm equivalent is `npm ci`. Do not run `pnpm run check` without build permission: it includes `bundle` and can rewrite committed `dist/cline-free.js`. No formatter command exists in the plugin package; do not add one as part of verification.

Put an installed OpenCode V2 executable on PATH, or pass an absolute path. The initial proof used `@opencode/cli@2.0.26` (not the `opencode-ai` 1.x package). If installation is approved and no host exists, install it outside the repository in a private tooling directory:

```sh
HOST=$(mktemp -d /tmp/cline-verify-host.XXXXXX)
printf '{"private":true,"name":"cline-verification-host"}\n' > "$HOST/package.json"
(cd "$HOST" && pnpm add @opencode/cli@2.0.26)
# Only if pnpm skipped this package's installation script:
(cd "$HOST" && node node_modules/@opencode/cli/postinstall.mjs)
OPENCODE="$HOST/node_modules/.bin/opencode"
"$OPENCODE" --version
```

The helper needs Linux, Python 3 (standard library only) and a working OpenCode V2 host. macOS/Windows need a separately verified process-ownership mechanism; do not claim this Linux helper is portable there.

```sh
CONTROL="$PWD/.agents/skills/verify-opencode-cline-free/scripts/control.py"
chmod +x "$CONTROL" # Restore the executable bit if a transfer dropped it.
RUN="/tmp/cline-verify-$(date +%Y%m%dT%H%M%S)-$$"
"$CONTROL" --run "$RUN" start --opencode "$OPENCODE" --port 41938
```

Choose a free loopback port for each run; never share another agent's instance. `$RUN` must not exist before `start`. The helper creates a private runtime, points config at this checkout and starts `opencode serve --hostname 127.0.0.1`. It waits up to 120 seconds for **this local plugin to be active, its provider/models to be registered, and its three login methods to exist**. An HTTP response alone is not readiness. On startup failure it cleans up automatically and preserves redacted logs.

## Doctor

```sh
"$CONTROL" --run "$RUN" doctor
```

Require exit 0 and `evidence/doctor.json` with `result: pass`. The read-only check verifies the owned PID/start identity, unchanged host version, authenticated access to the owned server, the local plugin source path and registered models/login methods. It does not validate a Cline credential. After authorization, `login-status` must separately show `complete`; a successful chat proves the credential actually works. Run doctor before any drive and whenever behavior looks wrong.

## Drive

### Discover without credentials

```sh
"$CONTROL" --run "$RUN" discover
```

Inspect `evidence/discovery.json`: plugin `cline-free` active, source is this checkout's `index.ts`, provider name `Cline Free`, models with `providerID: cline-free`, and login methods `device`, `cli`, and the manual key method. Record actual IDs and variants; rotations change.

### Authorize a disposable connection

After the user agrees:

```sh
"$CONTROL" --run "$RUN" login-start
```

Give the returned device URL/code to the user for approval in their own browser. Do not auto-open a browser or collect a token. The helper invokes the public OpenCode `integration.oauth.connect` API with `methodID: device`, not Cline internals. Recheck until `complete` or a terminal failure; do not repeatedly start new attempts:

```sh
"$CONTROL" --run "$RUN" login-status
```

Pending is not pass. A newer attempt supersedes the old one. URLs/codes and credentials live only under `runtime/`, not in persistent evidence.

### Run one free chat

Choose a model ID from both the current live `free` array and host discovery. Supply the Cline-native ID, not an extra `cline-free/` provider prefix:

```sh
"$CONTROL" --run "$RUN" chat --model cline-free/mimo-v2.6-flash --variant none
```

This is a known model/variant pair, not an assurance it is still free: the helper refuses absent/paid/unregistered models or variants. Use actual discovery results if the pair has rotated out. It creates a real host session with tools denied, submits a fixed marker prompt, waits for a successful idle outcome and the exact assistant marker, and records messages/session metadata plus a credential-free pool summary. It interrupts the session on timeout/failure. Do not treat exit 0 from prompt submission as completed inference.

## Evidence

Proof stays in `$RUN/evidence/`, outside the checkout. Capture the entry point/action and resulting observable state, not only the final screen. The helper writes:

- `launch.json`, `doctor.json`, `discovery.json`: host identity, local plugin and public registry state.
- `login-start.json`, `login-status.json`, `pool-summary.json`: authorization progress, host connection, credential-free persisted-account summary.
- `live-free-list.json`, `chat-action.json`, `chat-messages.json`, `chat-session.json`: live allowlist, model/variant, prompt, outcome, response and usage/cost data.
- `server.redacted.log`, `cleanup.json`: sanitized diagnostics and teardown proof.

Capture CLI commands/stdout/stderr/exit status or a terminal transcript for terminal journeys. Never record manual tokens, Authorization headers, raw pool files, raw server logs, OAuth access/refresh tokens, or device codes in committed artifacts. Redaction is defense in depth: review evidence manually before sharing. Labels/emails can still be personal data. Do not publish the entire runtime or raw API traffic. Report observed usage separately from confirmed billing; a live free listing is not an account-balance audit.

Use `pnpm test` for bounded regressions at existing mocked transport boundaries (429/401/402, persistence, cancellation). Label those results **regression tests**, not live failover proof. Do not add a fake host, mock login success or mutate the pool to pass a mapped journey. This repository has no dry-run that proves inference without a request; chat contacts Cline and uses quota.

## Cleanup

Run after every successful or failed iteration, including login cancellation:

```sh
"$CONTROL" --run "$RUN" cleanup
 test ! -d "$RUN/runtime"
 test -s "$RUN/evidence/doctor.json"
 test -s "$RUN/evidence/cleanup.json"
```

The helper signals only the process group it started after checking Linux PID/start identity, preserves a redacted server log and deletes the private runtime (credentials, database, cache, disposable project). Never kill by executable name or signal an unrelated PID. If ownership changed, stop and investigate; do not delete evidence or someone else's runtime. Confirm the loopback port is no longer accepting connections before starting another run. Remove only this run's temporary host installation and generated untracked pnpm lockfile, if created. Keep proof artifacts.

Local credential deletion is not server-side OAuth revocation. If the user requires revocation, use the account's supported connected-app controls; do not claim cleanup revoked the grant.

## Helpers and handoff

`scripts/control.py` is executable; `--help` lists its commands. Invoke it as shown above. It uses only the real host's public `/api/plugin`, `/api/provider`, `/api/model`, `/api/integration` and `/api/session` paths. Doctor/discovery are read-only; login/chat/cleanup mutate only the owned runtime and the explicitly authorized Cline connection/request.

Before handing over changes, execute launch → doctor → one mapped feature → cleanup and verify the evidence survives. A skill not executed is a draft. Read `VERIFICATION.md` for the initial proof and limits; rerun rather than treating an old result as proof of the current tree. Report passed, failed, blocked and untested entry points explicitly.

For maintenance, use the companion `maintain-verification-skill` when available to keep this map aligned with the host and plugin. Do not create a vendor-specific copy automatically or schedule runs without being asked.
