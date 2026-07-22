# Security Policy

claude-kanban executes code by design: it spawns headless `claude -p` sessions that can read and modify the projects you register. Keep that threat model in mind.

## Scope and assumptions

- The server binds to `127.0.0.1` only and rejects requests whose `Origin`/`Host` are not localhost (CSRF/DNS-rebinding protection). It is **not** meant to be exposed to a network — don't reverse-proxy it to the internet.
- The `guard.mjs` guardrails work by parsing commands — they are **not a sandbox**. See "Honest limits of the guardrails" in the README. For strong isolation, run projects in a container.
- Enabling `--dangerously-skip-permissions` per project is an explicit opt-in to weaker safety.

## Reporting a vulnerability

Please open a [GitHub security advisory](../../security/advisories/new) (preferred) or a regular issue if the report is not sensitive. Include reproduction steps and impact. There is no bug bounty; this is a side project, but reports are welcome and will be addressed on a best-effort basis.
