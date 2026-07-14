# API HTTP + WebSocket

O backend é um Fastify que escuta em `127.0.0.1:$PORT` (default `4400`) e só aceita conexões locais. Não há autenticação: quem alcança a porta pode tudo. Todas as respostas são JSON; erros vêm como `{ "error": "<mensagem>" }` com o status HTTP correspondente.

Em desenvolvimento o Vite (`:5544`) faz proxy de `/api` para `http://127.0.0.1:4400`, então a UI sempre chama caminhos relativos.

## Variáveis de ambiente

| Variável | Onde | Default | Efeito |
| --- | --- | --- | --- |
| `PORT` | server | `4400` | Porta do Fastify (host fixo em `127.0.0.1`). |
| `CLAUDE_KANBAN_HOME` | server | `~/.claude-kanban` | Raiz do estado do app: `projects.json`, `state.json`, `ledger.json`, `lock` e `worktrees/`. Aponte para outro diretório para rodar uma instância isolada (é o que a suíte de testes faz). |
| `CLAUDE_KANBAN_TASK_ID` | injetada pelo runner | — | Não configure: o runner exporta o id da task no ambiente da sessão `claude -p` para o `guard.mjs` saber a qual task associar uma ação bloqueada. |

## Convenções

- `:projectId` é o `id` (nanoid de 6 chars) devolvido por `POST /api/projects`. `:taskId` é o `id` do frontmatter da task.
- Rotas com `:projectId` respondem **404** se o projeto não existe. As rotas que tocam o filesystem do projeto (tasks, pending-actions, claude-config, branches, run) respondem **409** se o diretório do projeto sumiu do disco.
- Toda mutação relevante também é anunciada no WebSocket — o cliente não precisa refazer o GET.

## Objetos

### `project`

Retornado por `/api/projects` e afins (é o projeto persistido em `projects.json` + campos derivados, calculados a cada resposta):

```json
{
  "id": "Ab3xY9",
  "name": "meu-app",
  "path": "/Users/eu/code/meu-app",
  "createdAt": "2026-07-11T12:00:00.000Z",
  "skipPermissions": false,
  "defaultModel": null,
  "autoRun": false,
  "queuePausedUntil": null,
  "devServer": { "command": "npm run dev", "url": "http://localhost:3000" },
  "git": {
    "baseBranch": "main",
    "pullBeforeStart": false,
    "useCurrentBranch": false,
    "commitToNewBranch": true,
    "useWorktree": true,
    "autoPush": true,
    "autoPR": false,
    "autoPRDescription": true
  },
  "available": true,
  "bootstrap": "ok",
  "bootstrapError": null,
  "pendingCount": 0,
  "devServerRunning": false,
  "branch": "main"
}
```

`available` é `false` quando o diretório não existe mais; nesse caso `bootstrap` vira `"unknown"` e `branch` vira `null`. `git` é sempre o objeto completo (defaults + overrides). `queuePausedUntil` (ISO ou `null`) adia a fila **deste projeto**: os itens continuam enfileirados, na ordem, mas nenhum sai da fila antes do horário; o servidor limpa o campo sozinho quando a hora chega.

### `task`

```json
{
  "id": "a472lb",
  "title": "Documentar a API",
  "status": "doing",
  "priority": "medium",
  "tags": ["documentacao"],
  "model": null,
  "scheduled_at": null,
  "created_at": "...",
  "updated_at": "...",
  "run": {
    "session_id": null, "started_at": "...", "completed_at": null,
    "exit_code": null, "cost_usd": null, "duration_ms": null,
    "num_turns": null, "attempts": 1, "has_diff": false, "branch": "kanban/a472lb",
    "pr": { "url": "https://github.com/org/repo/pull/12", "number": 12, "state": "OPEN" }
  },
  "body": "## Descrição\n…",
  "filePath": "/abs/.claude/claude-kanban/tasks/doing/documentar-a-api--a472lb.md"
}
```

`run.pr` é a pull request aberta pela sessão quando o projeto tem `git.autoPR` ligado: ao terminar um run com `exit_code: 0` e `autoPush`, o servidor pergunta ao `gh` (`gh pr view <branch> --json url,number,state`) qual é a PR da branch da task e grava `{ url, number, state }` no frontmatter. Sem `gh` instalado/autenticado, ou sem PR aberta, o campo fica `null` e a UI não mostra o botão "Ver PR".

`status` ∈ `backlog | todo | doing | done | archived` e é **derivado da pasta** do arquivo — a pasta vence o frontmatter em caso de divergência.

`scheduled_at` (ISO ou `null`) agenda a task: quando o horário chega, o servidor a enfileira sozinho — mesmo com o auto-pilot desligado — e zera o campo. Só vale para tasks em `backlog`/`todo` e sem a tag `blocked`; enquanto o horário está no futuro, o auto-pilot **não** enfileira a task. A resolução é a do ticker (20s), então o disparo pode atrasar até esse tanto — nunca adiantar.

## Rotas

### Geral

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok: true, claudeAvailable }` — `claudeAvailable` é falso se o CLI `claude` não estava no PATH no boot. |
| `GET` | `/api/usage` | — | Limites do plano Claude: `{ available: false }` ou `{ available: true, limits: [{ kind, percent, severity, resetsAt, isActive, model }] }`. `kind` ∈ `session | weekly_all | weekly_scoped`. Cache de 60s; qualquer falha vira `available: false`. |
| `POST` | `/api/pick-folder` | — | Abre o seletor nativo (macOS). `{ path }` (ou `path: null` se cancelado). **501** fora do macOS. |
| `GET` | `/api/suggestion-types` | — | `{ types: { melhoria: "…", correcao: "…", … } }` — chaves aceitas em `/analyze`. |

### Projetos

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | — | `{ projects: [project] }` |
| `POST` | `/api/projects` | `{ name, path }` | `{ project }`. Roda o bootstrap (pastas, `guard.mjs`, skill, hooks) e inicia o watcher. **400** se falta campo, o diretório não existe ou não é gravável. Falha de bootstrap **não** falha a rota: aparece em `bootstrap: "failed"` + `bootstrapError`. |
| `PATCH` | `/api/projects/:projectId` | qualquer subconjunto de `{ name, skipPermissions, defaultModel, autoRun, enrichMode, devServer: { command, url }, git: {…} }` | `{ project }`. `devServer` e `git` são merges rasos. `enrichMode`: `"off" | "auto" | "always"` — política de enriquecimento da descrição na hora do run (**400** fora desses valores). Ligar `autoRun` enfileira imediatamente tudo que está em `todo/` (exceto tasks com as tags `blocked` ou `human-request`). |
| `POST` | `/api/projects/:projectId/bootstrap` | — | `{ project }`. Re-roda o bootstrap (idempotente). |
| `DELETE` | `/api/projects/:projectId?uninstallGuardrails=true` | — | `{ ok: true }`. Remove o projeto do app, esvazia a fila dele, para o dev server e o watcher. Com a query, também desinstala os hooks/guard do projeto. Não apaga tasks nem código. |

### Dev server

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/dev-server/launch` | — | Inicia o comando configurado (se ainda não estiver rodando) e abre a URL no Chrome. **400** se não há comando configurado. |
| `POST` | `/api/projects/:projectId/dev-server/stop` | — | Mata o process group inteiro (shell + filhos). **409** se não está rodando. |
| `GET` | `/api/projects/:projectId/dev-server` | — | `{ running, pid, startedAt, logs: [...] }` — buffer dos últimos ~500 chunks de stdout/stderr. |

### Branches

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/branches?fetch=true` | — | `{ branch, branches: [...], fetchError }`. Com `fetch=true` roda `git fetch` antes; um erro de fetch vira `fetchError` (não derruba a rota). |
| `POST` | `/api/projects/:projectId/branch` | `{ branch, stash? }` | Faz checkout. **400** sem `branch`. **409** `{ error, canStash }` se o checkout falhou — `canStash: true` indica que há mudanças locais e que repetir com `stash: true` resolveria. |

### Tasks

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/tasks` | — | `{ tasks: [task] }` |
| `POST` | `/api/projects/:projectId/tasks` | `{ title, description?, priority?, tags?, status?, model?, enrich?, decompose?, scheduled_at? }` | `{ task }`. Só `title` é obrigatório (**400** sem ele). Default: `priority: "medium"`, `status: "backlog"`. **400** se `scheduled_at` não é uma data ISO válida. `model` (aqui, no PATCH da task e no `defaultModel` do projeto) tem que ser o **slug exato** de um modelo do catálogo (`server/src/lib/models.js`): `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` — é ele que vai para `claude --model`. Apelidos legados (`opus`, `sonnet`…) são convertidos no slug; qualquer outro valor dá **400**. |
| `GET` | `/api/projects/:projectId/tasks/:taskId` | — | `{ task }` — **404** se não existe. |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId` | subconjunto do frontmatter (`title`, `status`, `priority`, `tags`, `model`, `enrich`, `decompose`, `scheduled_at`, `run`, `body`…) | `{ task }`. Mudar `status` move o arquivo de pasta e emite `task.moved`. `scheduled_at`: ISO agenda, `null`/`""` desagenda, lixo dá **400**. |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId` | — | `{ task }`. **Não apaga o arquivo**: move para `archived/`. |
| `POST` | `/api/projects/:projectId/tasks/:taskId/enrich` | `{ auto? }` | `{ enriched, reason, costUsd, task }`. Sessão headless read-only que reescreve a `## Descrição` (e possivelmente o título) para ficar mais clara e com contexto do código. Com `auto: true` o modelo só reescreve se julgar necessário (`enriched: false` caso contrário). **409** se a task está rodando ou o CLI `claude` não existe. |
| `GET` | `/api/projects/:projectId/tasks/:taskId/diff` | — | `{ diff }` — o patch unificado capturado ao fim do último run. **404** se a task não gerou diff. |

### Ações manuais (guardrails)

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/pending-actions` | — | `{ actions: [{ id: "pa-xxxxxx", timestamp, label, command, taskId, status }] }` — parse de `.claude/claude-kanban/pending-actions.md`. |
| `POST` | `/api/projects/:projectId/pending-actions/:actionId/resolve` | — | `{ actions }` (lista já atualizada). **404** se a ação não existe ou já foi resolvida. Emite `pending.updated`. |

### Configuração do Claude no projeto

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/claude-config` | — | `{ files: [...] }` — metadados dos arquivos editáveis (`CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, skills, agents, hooks…), sem conteúdo. |
| `GET` | `/api/projects/:projectId/claude-config/file?path=<rel>` | — | Conteúdo do arquivo. **400** se o `path` estiver fora da allowlist. |
| `PUT` | `/api/projects/:projectId/claude-config/file` | `{ path, content }` | Grava o arquivo e emite `project.updated`. **400** em path inválido. |

### Análise (sugestão de tasks)

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/analyze` | `{ types?: ["melhoria", …] }` | `{ suggestions: [{ title, description, type, priority }], costUsd }`. Roda uma sessão headless read-only. Sem `types`, usa todos. **409** se o CLI `claude` não existe; **500** em falha da análise. As sugestões **não** viram tasks sozinhas — cabe ao cliente `POST /tasks` as escolhidas. |

### Fila de execução

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/tasks/:taskId/run` | — | Enfileira a task. Devolve a `queueView`. **409** se já está na fila/rodando, ou se o CLI `claude` não existe. Enfileirar explicitamente **limpa o ledger** da task (permite re-executar algo já concluído). |
| `GET` | `/api/run/queue` | — | `queueView`: `{ actives: [{ projectId, taskId }], queue: [{ projectId, taskId }], maxConcurrency }`. |
| `POST` | `/api/run/queue/reorder` | `{ taskIds: [...] }` | `queueView`. Ids omitidos vão para o fim, na ordem atual. |
| `POST` | `/api/run/concurrency` | `{ max }` | `queueView`. Clampado em `1..8`. Duas tasks do **mesmo** projeto só rodam em paralelo se o projeto usar worktree isolado. |
| `POST` | `/api/run/kill` | `{ taskId? }` | `{ ok: true }`. Mata a sessão (SIGTERM, SIGKILL após 10s); a task volta para `todo/`. `taskId` é opcional só quando há exatamente uma sessão ativa — senão **409**. |
| `POST` | `/api/run/dequeue` | `{ taskId }` | `queueView`. Cancela uma task que **ainda não começou**: tira da fila. **409** se ela não está na fila (se já está rodando, use `/api/run/kill`). Com auto-run ligado, a task volta para `backlog/` — senão o próprio auto-run a re-enfileiraria na hora. |

### Agendamento

Agendar **uma task**: `PATCH .../tasks/:taskId` com `{ scheduled_at }` (ISO; `null`/`""` desagenda). Adiar **a fila do projeto**:

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/queue/pause` | `{ until }` | `{ project }`. Nada sai da fila desse projeto até `until`. **400** se `until` não é uma data ISO válida ou não está no futuro. Emite `project.updated`. |
| `POST` | `/api/projects/:projectId/queue/resume` | — | `{ project }`. Limpa a pausa e destrava a fila na hora. Emite `project.updated`. |

Uma pausa vencida é limpa pelo próprio servidor no tick seguinte (ou seja: `queuePausedUntil` no passado equivale a fila liberada).

## WebSocket

Conecte em `ws://127.0.0.1:4400/api/ws` (a UI usa `/api/ws` no mesmo host). Não há handshake, subscribe nem filtro: o servidor faz broadcast de **todos** os eventos de **todos** os projetos para **todos** os sockets. Filtre por `payload.projectId` no cliente.

Cada mensagem é uma linha JSON no formato `{ "type": "<evento>", ...payload }`. Não há replay: um socket que conecta depois perde o que passou — reconciliar via `GET /api/projects/:id/tasks` + `GET /api/run/queue` ao (re)conectar.

| Evento | Payload | Quando |
| --- | --- | --- |
| `task.upserted` | `{ projectId, task }` | Task criada ou alterada — pela API **ou** por edição direta do `.md` no disco (watcher). É o evento de "estado atual da task"; sempre acompanha um `task.moved`. |
| `task.moved` | `{ projectId, taskId, from, to }` | Mudança de status (pasta). `from`/`to` são status. Emitido antes do `task.upserted` correspondente. |
| `task.removed` | `{ projectId, taskId }` | Arquivo da task sumiu do disco de verdade (não é um move). O watcher espera ~1s antes de concluir isso, para não confundir com `unlink`+`add` de um rename. |
| `run.queued` | `{ projectId, taskId, position }` | Task entrou na fila. `position` é o índice no momento. |
| `run.started` | `{ projectId, taskId, pid }` | Sessão `claude -p` iniciou. |
| `run.log` | `{ projectId, taskId, event }` | Uma linha do `--output-format stream-json` da sessão. `event` é o objeto do próprio Claude Code (`assistant`, `user`, `result`…); linhas não-JSON viram `{ type: "raw", text }`. Este é o evento de alto volume. |
| `run.finished` | `{ projectId, taskId, exitCode, humanRequest?, costUsd, durationMs, numTurns, sessionId, pr? }` | Sessão terminou (sucesso, erro ou timeout). `exitCode: 0` ⇒ task foi para `done/` e registrada no ledger — exceto se o agente deixou uma seção `## Human Request` preenchida: nesse caso `humanRequest: true`, a task volta para `todo/` com a tag `human-request` (fora do auto-pilot) e aguarda decisão do humano; qualquer outro valor ⇒ volta para `todo/` e o motivo é anexado ao "## Log de erros" da task. `exitCode: -1` também cobre falha ao preparar o workspace git. `pr` é `{ url, number, state }` da PR aberta pela sessão (`autoPR`), ou `null` — o mesmo valor gravado em `run.pr` no frontmatter. |
| `run.killed` | `{ projectId, taskId }` | Sessão morta manualmente (`/api/run/kill`). A task volta para `todo/` e **não** re-entra sozinha na fila, mesmo com auto-run ligado. |
| `run.dequeued` | `{ projectId, taskId }` | Task cancelada antes de começar (`/api/run/dequeue`): saiu da fila. Vem seguido de um `run.queue`. |
| `run.queue` | `queueView` | A fila foi alterada por fora do fluxo normal (remoção de um projeto, cancelamento de um item da fila). |
| `pending.updated` | `{ projectId, actions }` | `pending-actions.md` mudou (guardrail bloqueou algo, ou uma ação foi resolvida). |
| `devserver.updated` | `{ projectId, running, pid, startedAt, exitCode? }` | Dev server iniciou ou morreu. `exitCode` só aparece quando o processo terminou. |
| `project.updated` | `{ projectId }` | Algo do projeto mudou fora do board (checkout de branch, escrita em claude-config). Sinal de "refaça o `GET /api/projects`". |

## `~/.claude-kanban/` (ou `$CLAUDE_KANBAN_HOME`)

Todo o estado global do app é arquivo — não há banco de dados.

```
~/.claude-kanban/
├── projects.json          # { projects: [...] } — os projetos cadastrados (id, path, git, devServer, flags)
├── state.json             # { queue: [{projectId, taskId}], maxConcurrency } — a fila sobrevive a restarts
├── ledger.json            # { executed: { <taskId>: { exitCode: 0, completedAt, sessionId } } }
├── lock                   # pid da instância viva; o boot aborta se o pid ainda responde
└── worktrees/<projectId>/<taskId>/   # worktree git isolado de cada run
```

O que é do **projeto** (e não do app) vive em `<projeto>/.claude/claude-kanban/`: `tasks/<status>/*.md`, `diffs/<taskId>.diff`, `pending-actions.md`, a skill e o `guard.mjs`.

### Por que existe o `ledger.json`

O status de uma task vive na **pasta** do arquivo `.md` — e essas pastas são explicitamente excluídas dos commits da sessão (`info/exclude`, ver `git.js`). Consequência: uma task que rodou em worktree e terminou pode ter seu `done/` perdido — o worktree é descartado, um checkout troca a branch, o arquivo reaparece em `todo/`. Com auto-run ligado, isso é um loop infinito: a mesma task re-executa para sempre.

O ledger é a resposta: um registro persistente, fora do git, de "esta task já rodou com exit 0". Ele é gravado **antes** de qualquer coisa depender do status.

As regras:

- **Só sucesso entra.** Exit ≠ 0, timeout e morte manual não são registrados — essas re-executam normalmente (até 3 tentativas, depois a task ganha a tag `blocked` e o auto-run a ignora).
- **Caminho automático** (auto-run, recovery pós-restart): se a task está no ledger, ela **nunca** re-executa. Em vez disso o status é reconciliado para `done` — o app corrige o filesystem em vez de refazer o trabalho.
- **Caminho explícito** (`POST .../run` disparado por um humano): o registro é apagado e a task roda de novo. Pedir explicitamente é a forma de dizer "sim, quero rodar outra vez".

Para forçar a re-execução de tudo, apague `ledger.json` com o servidor parado.
