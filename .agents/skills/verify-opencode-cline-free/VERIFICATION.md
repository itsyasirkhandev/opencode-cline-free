# Initial verification

## Target and scope

- Date: 2026-10-20 (UTC).
- Product checkout: `86d37fab5d0fef98bddc36ab39fe75384f0be41a`.
- Host: real `@opencode/cli@2.0.26`, reporting `opencode v2.0.26`.
- Environment: Linux sandbox, Node 24 and Python 3.13; fresh disposable project, HOME/XDG directories, pool and model cache.
- Automated user entry point: OpenCode V2 public API. No plugin test seam or fake host was used for this proof.

## Passed

1. Repository baseline: `pnpm run typecheck` succeeded; `pnpm test` passed **133/133**, with no skipped, failed or cancelled tests. These are regression tests, not live chat/failover proof.
2. Generated helper lifecycle: launch → doctor → discovery (D1/D2 API entry point) → cleanup, rerun after the helper's final safety changes.
3. Usable readiness: the owned real host loaded this checkout's `index.ts` as active plugin `cline-free`; its provider, nonempty models and three login methods were registered.
4. Actual model/variant registry was captured. During this run it contained eight Cline-provider models: five live free entries and three paid extras. The free IDs included `cline-free/minimax-m3.1-flash`, `cline-free/nemotron-3.5-super-vl`, `cline-free/mimo-v2.6-flash`, `cline-free/muse-spark-1.3-contributor`, and `cline-free/solar-mini4`. This list is historical evidence, not an allowlist for future chat.
5. Cleanup: both owned probe/verification servers stopped; ports 41937/41938 no longer accepted connections; private runtime was removed; nonempty launch/doctor/discovery/cleanup evidence and a redacted log survived outside the checkout.
6. Helper syntax and focused safety checks passed: nested credential redaction and refusal of an in-repository runtime, a privileged port, and an already-existing run directory.
7. Markdown was formatted and checked with Prettier; repository diff whitespace was checked. No plugin product code, dependency manifest/lockfile, bundle or website change is part of this work.

## Blocked or not attempted

- A1 authenticated success and C1/C2 inference: a real device login was initiated through the host, but user authorization did not complete before timeout. The host reported `failed: Cline device authorization timed out`. **No authenticated chat or paid-model inference request was made.** The helper's successful-login and chat branches remain unproved end to end.
- CLI/TUI dialogs, GitHub/copy installation, committed bundle parity, offline cache/fallback, account rename/remove/re-login, tool execution, multi-account live routing/recovery and in-flight cancellation were not live-verified.
- No quota was deliberately exhausted and no paid-model request was submitted. Existing mocked-boundary regressions are not evidence of live failover.
- A successful local cost display would not prove upstream billing; no account-balance audit was performed.

## Setup-specific limits

The sandbox is a stand-in for the user's development machine. It installed a pinned V2 host into an external tooling directory, explicitly ran that package's postinstall because pnpm skipped it, and imported the repository's npm lock temporarily for pnpm installation. The generated pnpm lockfile was removed; no dependency migration is proposed. An unlocked install selected `@opencode/plugin@2.1.0` and failed because its schema dependency was unavailable; locked 2.0.26 installed and ran successfully.

The proof does not establish the user's installed host version, desktop/browser environment, account login, TUI behavior or machine-specific installation. The helper relies on Linux `/proc` process-start identity. macOS/Windows are unverified and need a different owned-process check.

## Retained evidence and follow-up

Raw run artifacts stay outside Git in each run's `evidence/` directory. The final unauthenticated lifecycle preserved `launch.json`, `doctor.json`, `discovery.json`, `server.redacted.log` and `cleanup.json`. The earlier authorization attempt also preserved credential-free login start/status results. Device URLs/codes and private runtime were not committed. This summary records the proof; it is not a substitute for rerunning on a changed checkout.

For authenticated proof, launch a new owned run, ask the user to approve a new device URL, require `login-status: complete`, choose a currently free registered model/variant, run `chat`, inspect action/message/session/side-effect evidence, then clean up and confirm evidence survives. Do not reuse the expired code. Keep CLI/TUI and multi-account journeys separately marked until actually driven.
