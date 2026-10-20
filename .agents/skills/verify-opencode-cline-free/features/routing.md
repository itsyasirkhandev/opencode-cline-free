# Account routing and failure recovery

A user's session stays on a healthy account for each model and can recover from quota/auth failures without silently changing unrelated sessions or billing a paid model unexpectedly.

## Sub-features

- R1: Keep a session/model on the same account across turns.
- R2: Skip per-model cooldowns and retain them across restarts.
- R3: Recover from 429 or auth rejection using another healthy account.
- R4: Preserve non-auth failures and stop retries on cancellation.
- R5: Distinguish paid-model credit exhaustion from free-model quota.

## How to get to it (user POV)

- Connect multiple authorized Cline accounts, choose a free model and submit repeated turns in the same OpenCode session.
- Request `cline_free_status` to inspect account health/cooldowns and `NEEDS-RELOGIN`/`NO-CREDITS` indicators.
- Cancel a running turn using the host's interrupt action or terminal cancel control.
- Run the repository's existing regression tests for bounded transport failures without exhausting real quota.

## Driving it with the OpenCode host and regression suite

Preconditions: live R1–R4 require authorized disposable accounts and observable account-selection evidence. Natural cooldown/auth-failure state must exist for a live failure journey. Do not manufacture these states by editing internals or exhausting accounts.

- **R1 live:** connect two permitted test accounts, submit two marker turns in the same host session with the same free model, and inspect credential-free routing/status evidence. Require the same account marker across turns, not merely two successful responses. The helper's `chat` creates a new session each invocation, so repeated helper calls do not prove session pinning.
- **R2/R3 live:** if a test account is already naturally limited on a free model and another is healthy, capture status, send a turn through the real host, then capture response and status again. Require success on the healthy account and the appropriate per-model cooldown. Restart with the same owned disposable data and confirm cooldown persistence. If those preconditions/observations are absent, report blocked; a single healthy account is insufficient.
- **R4 live:** use the public `POST /api/session/{sessionID}/interrupt` on an owned running session (or cancel it in the TUI), then inspect session/message outcome and confirm no continued retries. A post-completion interrupt is not cancellation proof. Natural non-auth 403/5xx requires a controlled external boundary or report blocked.
- **R1–R5 regression:** from repository root run `pnpm test`. Require all tests pass and retain command/stdout/stderr/exit code. Existing regression suites cover pinning, per-model selection, recovery, persistence and cancellation at mocked transport/adapter boundaries. Inspect individual test names before attributing coverage. These are not live OpenCode/UI/failover proof.
- **R5:** use the existing tests only in this workflow. No live paid-model request is authorized; do not spend credits to verify 402 recovery.

## Gotchas

- Never intentionally hit quota, revoke production credentials, forge JWTs into the live host, or patch internal pool state to label this journey live-passed.
- Account status after two turns alone may not prove which account served each turn; report the observability gap instead of assuming pinning.
- Provider failures can depend on changing upstream behavior. Distinguish unavailable preconditions from a reproduced defect.
- The helper automates safe discovery/login/single free chat, not live multi-account fault injection or same-session multi-turn proof. Uncovered paths remain explicit.
