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

8. Authenticated follow-up on the uploaded branch: a fresh user-approved device flow completed through the real host (A1 API). Host discovery showed a Cline connection and the persisted pool summary contained one account.
9. C1/C2 API chat: the helper checked the current live free list, selected `cline-free/mimo-v2.6-flash` with variant `none`, created a real host session and sent the marker prompt. The stored session retained that exact model/variant, completed with `outcome: succeeded`, and its assistant message had `finish: stop`, no error, and exact text `VERIFY_CLINE_FREE_OK`.
10. Authenticated side effects and cleanup: the disposable project contained no files; the host was stopped, port 41938 was closed, and local credentials/runtime were removed. Nonempty login, free-list, chat-action/message/session, pool-summary and cleanup evidence survived. The original unapproved attempt expired; its code was not reused.

## Billing observation

The selected model was present in Cline's live `free` array immediately before the request, and no paid model was selected. However, the stored OpenCode session reported a nonzero cost of **$0.00005586** (floating-point value `0.000055860000000000004`). This is host-reported cost telemetry, not proof of actual Cline billing. No Cline balance/transaction audit was performed, so a zero-charge outcome is **not verified**. Do not suppress this discrepancy or repeat inference solely to investigate it without approval.

## Blocked or not attempted

- CLI/TUI dialogs, GitHub/copy installation, committed bundle parity, offline cache/fallback, account rename/remove/re-login, tool execution, multi-account live routing/recovery and in-flight cancellation were not live-verified.
- No quota was deliberately exhausted and no paid-model request was submitted. Existing mocked-boundary regressions are not evidence of live failover.
- A successful local cost display would not prove upstream billing; no account-balance audit was performed.

## Setup-specific limits

The sandbox is a stand-in for the user's development machine. It installed a pinned V2 host into an external tooling directory, explicitly ran that package's postinstall because pnpm skipped it, and imported the repository's npm lock temporarily for pnpm installation. The generated pnpm lockfile was removed; no dependency migration is proposed. An unlocked install selected `@opencode/plugin@2.1.0` and failed because its schema dependency was unavailable; locked 2.0.26 installed and ran successfully.

The proof does not establish the user's locally installed host version, desktop/browser environment, local account/session state, TUI behavior or machine-specific installation. The helper relies on Linux `/proc` process-start identity. macOS/Windows are unverified and need a different owned-process check.

## Retained evidence and follow-up

Raw run artifacts stay outside Git in each run's `evidence/` directory. The final unauthenticated lifecycle preserved `launch.json`, `doctor.json`, `discovery.json`, `server.redacted.log` and `cleanup.json`. The earlier authorization attempt also preserved credential-free login start/status results. The successful authenticated follow-up additionally preserved `login-status.json`, `pool-summary.json`, `live-free-list.json`, `chat-action.json`, `chat-messages.json`, and `chat-session.json` through cleanup. Device URLs/codes and private runtime were not committed. This summary records the proof; it is not a substitute for rerunning on a changed checkout.

Authenticated API login and one model/variant chat are now proved on the recorded host/checkout. Keep CLI/TUI, other variants/models and multi-account journeys separately marked until actually driven. Future reruns require a new owned instance and fresh user authorization; the local credentials from this proof have been deleted. Resolve the cost-telemetry discrepancy against Cline account billing before claiming zero-charge inference.
