# Cline Free verification map

Read this index before choosing a journey. The map describes user-visible behavior in OpenCode V2, not internal module calls. The plugin's marketing website is excluded.

## Baseline preconditions

- Use `../SKILL.md` to launch an owned Linux host against this checkout with disposable HOME/XDG directories, project, pool and cache.
- Require `control.py --run "$RUN" doctor` to pass. Bind only loopback; each parallel run needs its own port and state.
- Do not inherit account tokens or a Cline CLI login. Network access is necessary for live discovery and authorization; chat additionally needs an approved Cline connection and a currently free model.
- `$CONTROL` and `$RUN` refer to the variables established in the skill. Preserve evidence outside `runtime/`.

## Driving conventions

- Restore a fresh baseline for independent journeys. Do not reuse the user's OpenCode background service.
- Public API operations and CLI/TUI dialogs are distinct entry points. Record exactly which was exercised. API proof does not cover a terminal dialog.
- Use literal command/menu names and host model IDs. Do not assume the README's historical model rotation is current.
- Do not force rate limits, spend paid credits, fabricate credentials, or seed internal cooldown state to obtain a live pass.

## Proof and skip reporting

- Pair every action with the host response/terminal transcript and resulting state. Mutation proof includes a second read or persisted credential-free summary.
- Record the feature/sub-feature ID, host version, checkout revision, entry point, result and artifact names.
- Distinguish live proof, mocked-boundary regression tests, blocked preconditions and paths not attempted.
- If a required account/model/variant is absent, report the journey blocked with the attempted command. Never weaken the expected behavior or substitute another entry point silently.
- Cleanup removes private runtime and credentials, never evidence. Inspect artifacts for secrets and personal data before publishing.

## Features

- [Discovery](discovery.md): plugin loading, current model list, variants and cached startup.
- [Login and accounts](accounts.md): device, local CLI and manual login; labels, status, removal and deduplication.
- [Chat and variants](chat.md): free-model selection, actual inference and supported reasoning choices.
- [Routing and recovery](routing.md): session pinning, cooldowns, auth recovery, failover and cancellation.
