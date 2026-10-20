# Login and account management

A user connects Cline accounts, sees short connection labels, and manages the rotation pool without duplicating a re-login or exposing credentials.

## Sub-features

- A1: Complete device-code login and persist one account/host connection.
- A2: Import an existing local Cline CLI login after confirmation.
- A3: Add a manual token; distinguish unvalidated connect-time storage from tool validation.
- A4: Show status, rename/remove a disposable account and retain the change.
- A5: Re-login to the same Cline identity without creating another pool account.

## How to get to it (user POV)

- `/connect` → Cline Free → `Cline account (free models, recommended)`.
- `opencode auth login cline-free --method device`.
- `/connect` → Cline Free → `Reuse Cline CLI login (this machine, 1 confirm)` or `Cline token (manual)`.
- `/connect` → Cline Free → select account → `ctrl+r` for rename; account-list delete for logout.
- In an authorized chat, request `cline_free_status`, `cline_free_add_token`, or `cline_free_remove`.
- Public `integration.oauth.connect` and attempt-status APIs (device path automated by the helper).

## Driving it with the OpenCode public API and terminal

Preconditions: baseline host; explicit user approval to connect a disposable account. Never copy production pool/CLI token files into this run.

- **A1 API:** run `"$CONTROL" --run "$RUN" login-start`; have the user approve the returned device URL in their own browser. Run `"$CONTROL" --run "$RUN" login-status` until complete. Require `login-status.json` complete, a connection in `discovery.json`, and exactly the expected account count in `pool-summary.json`. Do not expose the raw pool.
- **A1 terminal:** in an isolated standalone CLI, run `opencode auth login cline-free --method device --standalone`; record the user path without retaining its URL/code in evidence. Test `/connect` separately to prove the dialog.
- **A2:** establish a deliberately disposable Cline CLI login on the same verification machine, then select the exact CLI-import method. Confirm the displayed identity matches the expected test user; require host connection and pool summary after completion. Without that precondition, report blocked, not a device-login substitute.
- **A3:** use the manual-token method only through secure user input. Connect-time acceptance is not validation; require an authorized free chat or validated `cline_free_add_token` result. Do not pass a token through prompts, transcripts, shell arguments or committed evidence.
- **A4:** request `cline_free_status` in a separate authorized tool-enabled test session (the helper's marker chat denies tools). Record tool name and credential-free result. Rename only a disposable connection via `ctrl+r`; inspect the connection list again. Remove that disposable account using `cline_free_remove` with the displayed `acc_...` ID; require a second status read and persistence after host restart. Do not delete another account.
- **A5:** record the pool account count, repeat A1 with the same Cline user, then read status/summary again. Require the same stable identity/count and working login. Different Cline users are a different scenario.

## Gotchas

- Never infer the Cline identity from the user's Notion email. Device URLs/codes expire; a new attempt supersedes the previous attempt.
- A pending/expired attempt is not login success. `complete` is connection proof; a real chat separately validates usable inference credentials.
- The harness starts with an empty HOME and no inherited Cline session; CLI import is expected to be unavailable until deliberately provisioned.
- Env-var accounts are ephemeral; removing a stored account does not unset a process environment variable. This helper intentionally inherits none.
- Cleanup deletes local credentials but does not revoke a server-side OAuth grant.
