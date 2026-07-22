# claude-kanban

> [Versão em português](README.pt-BR.md)

> **Disclaimer:** This is an unofficial community project, not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC.

A local task manager (React + Node) for [Claude Code](https://claude.com/claude-code). The kanban board is a visual layer over plain `.md` files in each project's `.claude/claude-kanban/tasks/` folder; tasks are executed in headless sessions (`claude -p`), one at a time, with a live log on the board.

![claude-kanban board](docs/screenshot.png)

Full spec: [`docs/initial-scope.spec`](docs/initial-scope.spec). HTTP routes, WebSocket events and state layout: [`docs/api.md`](docs/api.md).

## Requirements

- Node 20+
- The `claude` CLI on your PATH (to run tasks)

## Running

```bash
npm install
npm run dev        # backend on :4400 + frontend on :5544 (proxied /api)
```

Open http://localhost:5544 and register a project (name + root directory) — this triggers the **bootstrap**: folder structure, `guard.mjs`, the `claude-kanban` skill, and a merge of the hooks into `.claude/settings.json` (idempotent, preserves existing content).

## Tests

```bash
npm test           # guard.mjs suite + core (tasks, bootstrap, pending)
```

## How it works

- **The filesystem is the source of truth.** Status lives in the folder (`backlog/ todo/ doing/ done/ archived/`) and in the frontmatter; when they disagree, **the folder wins** (reconciled on boot and via the watcher).
- **Task suggestions by analysis.** The "✨ Suggest tasks" button runs a read-only headless session (`Read`/`Glob`/`Grep`) over the project and suggests tasks of the types you pick (improvement, bugfix, feature, refactor, test, docs). You choose which ones become Backlog cards — created with the `sugerida` tag plus the type, for filtering.
- **Global execution queue**, concurrency 1. Each task runs in a fresh, isolated session — `--permission-mode acceptEdits` by default, or `--dangerously-skip-permissions` if the per-project toggle is on.
- **Deterministic guardrails** (`PreToolUse` hooks with `deny`, enforced even under skip-permissions):
  - no reading/writing `.env` (except `.example`/`.template`);
  - no committing/pushing/merging to `main`/`master`;
  - no deleting branches;
  - no deleting files outside the project — blocked actions become items in "Manual actions" (`pending-actions.md`) for a human to handle.

### Honest limits of the guardrails

`guard.mjs` works by parsing/regex over the command — **it is not a sandbox**. Obfuscated commands (variables, base64, intermediate scripts) can slip through. The guardrails cover the realistic case of the model attempting the action directly; for strong isolation, run the project in a container/worktree.

## Structure

```
server/   Fastify + watcher (chokidar) + runner (spawn claude -p) + templates (guard.mjs, SKILL.md)
web/      React + Vite + Tailwind + dnd-kit
docs/     initial spec + docs/api.md (HTTP routes, WS events)
```

App state lives in `~/.claude-kanban/`. No database — everything is a file:

```
projects.json                  registered projects (path, git, dev server, flags)
state.json                     execution queue + concurrency (survives restarts)
ledger.json                    tasks that have completed with exit 0
lock                           pid of the live instance (prevents two instances)
worktrees/<projectId>/<taskId> isolated git worktree for each run
```

The **ledger** exists because a task's status lives in the *folder* of its `.md` file, and those folders are excluded from session commits. Without it, a completed task whose `done/` entry got lost (discarded worktree, branch switch) would reappear in `todo/` and, with auto-run enabled, re-execute in a loop. The rule: only successes enter the ledger; automated paths never re-run something recorded there (they only reconcile status to `done`); a run explicitly requested by a human clears the record and runs again.

What belongs to the project — not the app — lives in `<project>/.claude/claude-kanban/`: `tasks/<status>/*.md`, `diffs/`, `pending-actions.md`, the skill and `guard.mjs`.

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4400` | Backend port (host fixed at `127.0.0.1`). |
| `CLAUDE_KANBAN_HOME` | `~/.claude-kanban` | Root of the state above. Point it elsewhere to run an isolated instance. |
| `CLAUDE_KANBAN_ALLOWED_ORIGINS` | — | Extra allowed `Origin`s (comma-separated) besides `http://localhost:5544` / `http://127.0.0.1:5544`. Requests from other origins or non-localhost hosts get 403. |

## License

[MIT](LICENSE)
