# Free-model chat and reasoning variants

A user selects a currently free Cline model, chooses a supported reasoning effort and receives a completed response through the plugin's real HTTP hooks.

## Sub-features

- C1: Select a free model and finish a text turn.
- C2: Use a registered reasoning variant for that model.
- C3: Read session history/usage after completion and confirm no unintended file changes.

## How to get to it (user POV)

- `/models` → Cline Free → a current free model; `/variants` → a supported effort; submit a prompt.
- `opencode run --model provider/model#variant` (for example `cline-free/cline-free/mimo-v2.6-flash#none`, only while it remains free).
- Public `session.create` with a model reference, then `session.prompt` and session/message reads.

## Driving it with the OpenCode public API and terminal

Preconditions: authorized disposable Cline connection, network access, a model present in both live `free` and host discovery, supported variant if specified.

- **C1/C2 API:** run `"$CONTROL" --run "$RUN" chat --model cline-free/mimo-v2.6-flash --variant none`, substituting an actually available free ID/variant when the rotation changes. The helper checks live free membership before submitting the fixed marker prompt through the real host. Require exit 0, a successful idle outcome and exact text `VERIFY_CLINE_FREE_OK` in `chat-messages.json`. Inspect `chat-action.json` and `chat-session.json` for the selected model/variant and result.
- **C1/C2 terminal:** in a separately configured isolated standalone host, run `opencode run --standalone --model cline-free/cline-free/mimo-v2.6-flash#none --format json 'Reply with exactly VERIFY_CLINE_FREE_OK. Do not call tools or modify files.'` only after verifying current free status and authorizing that isolated instance. Capture command, response, model/variant, exit code and stored session. The API helper's login does not provision another host automatically.
- **C2 TUI:** open `/models`, select the current model, open `/variants`, select an offered effort and submit the marker prompt. Capture both selection action and completed response; an API model reference alone does not prove the picker.
- **C3:** read the stored session/messages (the helper writes both), account summary and disposable project contents before cleanup. Require no product/source changes or unexpected project files. Inspect actual usage/cost; do not equate a local display with confirmed account billing.

## Gotchas

- The Cline-native ID itself may contain `/`; the terminal model spec has the provider prefix as well. The helper's `--model` takes only the native ID.
- Variants differ by model. MiMo's known `none`/`high` choices are not the effort set for every model.
- The helper fails closed when the live free endpoint is unavailable. Do not bypass that guard using the fallback list.
- A registered model, successful prompt submission, partial stream or clean HTTP status is not a completed chat. Preserve failures/timeouts rather than reporting pass.
- Tools are denied in helper marker sessions. Tool registration/execution requires its own account-management journey.
