# Seven-defect review fix handoff

Base commit: `8aa1c3942f77bd179388becf5ba872c967de05cf`.

These are local changes only: no commit, push, release, or authenticated live
Cline/WorkOS request was made. Package versions and the lockfile are unchanged.

## Implemented fixes

1. **Stale pool persistence:** every pool save and token refresh uses the same
   cross-process mutex. Saves three-way-merge local deltas against their last
   read/committed baseline and the locked disk state. Credentials are one atomic
   compare-and-swap group; unchanged stale credentials and stale-credential
   health reports cannot overwrite a peer's rotation. Account additions,
   removals, removal tombstones, explicit re-logins, per-model updates, metadata,
   and active-account changes merge without replacing the whole disk snapshot.
   Live account objects retain their identity. Refresh uses a private lock-held
   persistence path, avoiding recursive locking. Atomic temporary-file rename
   and mode `0600` are retained. Concurrent stale-lock recovery cannot remove a
   successor's nonempty lock directory. Refresh adopts peer-rotated credentials,
   including using a peer's rotated refresh token when its access token has
   already expired; independent processes/pool objects do not double-refresh.
2. **Authentication body deadlines:** `fetchWithTimeout` buffers small auth
   responses under one deadline covering fetch and body reads, with a 1 MiB
   size guard. Caller cancellation preserves its reason, cancels outstanding
   reads, and cleans listeners/timers. This helper is not used for inference.
   Successful inference streams, including failover streams, remain untimed and
   retain caller cancellation after headers.
3. **Environment identity:** env account IDs use the complete SHA-256 digest of
   the full normalized token. Same-length tokens sharing display prefixes and
   suffixes have separate credentials, cooldowns, and quarantine state.
4. **Cooldown independence:** `limitedUntil` is solely global; `modelLimits`
   remains solely per model. `limitsVersion: 2` distinguishes the new account
   representation. `cooldownUntil` computes aggregates for display and the true
   next eligibility for a known model. Selection, initial router selection,
   earliest-reset fallback, persistence, and pruning respect both independently.
5. **Device start retry scope:** response parsing, required-field checking, and
   HTTP/OAuth classification now occur inside `withTransientRetries`. HTTP
   429/5xx and malformed successful bodies retry; terminal failures do not.
   An optional abort signal also stops in-progress calls and retry backoff.
6. **Fetch overrides:** routed requests are normalized with
   `new Request(input, init)`, honoring effective method, replacement body,
   replacement headers, signal, GET defaults, and standard fetch options.
   All retry sends use the same effective buffered body. Explicit stream bodies
   in `RequestInit` remain single-shot passthrough; Request-body buffering is
   cancellable, and invalid method/body combinations reject normally.
7. **Routing trust boundary:** routing requires the exact parsed
   `https://api.cline.bot` origin, no embedded URL credentials, and exactly
   `/api/v1/chat/completions` or `/api/v1/completions` (optional trailing slash).
   Lookalike hosts, ports, schemes, path suffixes, and query-only matches do not
   receive pooled credentials or automatic replays.

## Changed files

- `src/core/pool.ts` — persistence/locking, env IDs, cooldowns, URL validation.
- `src/core/http.ts` — bounded auth consumption, cancellation-aware retries.
- `src/core/auth.ts` — device-start retry scope, polling cancellation cleanup.
- `src/core/router.ts` — Request semantics, replay/cancellation, cooldown use.
- `src/core/account.ts` — correct model/global earliest-reset calculation.
- `test/review-regressions.test.ts` — 43 focused offline regression cases.
- `test/fixtures/pool-worker.ts` — real subprocess persistence/refresh fixture.
- `dist/cline-free.js` — rebuilt single-file plugin.
- `docs/REVIEW_FIXES.md` — this handoff.

## Verification

Environment: Linux, Node `v24.14.1`.

Development dependencies were installed with `npm ci --ignore-scripts --no-audit
--no-fund` after inspecting package and lockfile configuration. Dependency
lifecycle scripts were not run.

- `npm run check`: **PASS** (TypeScript, 94/94 tests via tsx, esbuild bundle).
- `node --test test/*.test.ts`: **PASS**, 94/94, no skipped/cancelled tests.
- The existing 51 tests remain passing; 43 regression cases were added.
- `git diff --check`: **PASS**.
- Rebuilt `dist/cline-free.js`: approximately 94.3 KiB.

Regression fixtures use fake credentials and mocked authentication transports.
Timeout/retry regressions use virtual timers rather than waiting for real
15-second deadlines. IPC barriers load genuinely stale snapshots in separate
Node processes before ordering or racing writes. Coverage includes concurrent
adds, removals/re-logins, refresh deduplication, expired peer credentials,
metadata/cooldown merging, stale-lock reapers, file permissions, cancellation,
legacy cooldown migration, Request overrides on failover, and untouched
lookalike-host requests.

## Apply the patch

From a clean checkout of the base commit:

```sh
git apply --check opencode-cline-free-seven-fixes.patch
git apply opencode-cline-free-seven-fixes.patch
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The source archive includes all tracked repository files plus these changes and
the rebuilt bundle. It excludes `.git`, `node_modules`, account files, secrets,
and machine-specific environment files.

## Limits and deployment notes

- Stop/restart **all** OpenCode instances using the shared pool when upgrading.
  An old plugin process still running its unconditional whole-file writer can
  bypass the new persistence protocol; mixed-version writers are unsupported.
- The mutex assumes a local filesystem with atomic rename/nonempty-directory
  semantics and local process IDs. Network/distributed filesystems and
  cross-host shared pools are not supported. Linux/Node 24 was verified; other
  OS/runtime combinations were not exercised here.
- Legacy cooldown state is intrinsically ambiguous when a real global cooldown
  exactly equals the old per-model maximum. Migration interprets an exact match
  as the historical model aggregate; distinct values remain true global limits.
  New writes carry an explicit format marker and do not have this ambiguity.
- No live authenticated end-to-end Cline or WorkOS test was performed. Provider
  behavior and real quota/refresh-token rotation require an authorized manual
  smoke test after deployment.
