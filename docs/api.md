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
  "searchSources": [],
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

`searchSources` é a lista de fontes de busca customizadas do projeto (ver [Search sources](#search-sources)); vem sempre como array (`[]` quando o projeto nunca cadastrou nenhuma). `available` é `false` quando o diretório não existe mais; nesse caso `bootstrap` vira `"unknown"` e `branch` vira `null`. `git` é sempre o objeto completo (defaults + overrides). `queuePausedUntil` (ISO ou `null`) adia a fila **deste projeto**: os itens continuam enfileirados, na ordem, mas nenhum sai da fila antes do horário; o servidor limpa o campo sozinho quando a hora chega.

### `task`

```json
{
  "id": "a472lb",
  "title": "Documentar a API",
  "status": "doing",
  "priority": "medium",
  "tags": ["documentacao"],
  "model": null,
  "depends_on": [],
  "scheduled_at": null,
  "created_at": "...",
  "updated_at": "...",
  "run": {
    "session_id": null, "started_at": "...", "completed_at": null,
    "exit_code": null, "cost_usd": null, "duration_ms": null,
    "num_turns": null, "attempts": 1, "has_diff": false, "branch": "kanban/a472lb",
    "exit_reason": null,
    "pr": { "url": "https://github.com/org/repo/pull/12", "number": 12, "state": "OPEN" }
  },
  "body": "## Descrição\n…",
  "filePath": "/abs/.claude/claude-kanban/tasks/doing/documentar-a-api--a472lb.md"
}
```

`run.exit_reason` diz por que o último run terminou (`null` = sucesso ou pedido humano): `timeout`, `killed` (cancelado pelo usuário), `max_turns`, `max_budget`, `execution_error`, `api_error` (erro no evento `result` do CLI, ex.: crédito insuficiente — a mensagem vai para o "## Log de erros"), `signal` (processo morto sem exit code), `verify_failed`, `review_rejected` (revisão automática reprovou), `goal_budget` (teto de custo do objetivo), `integration_conflict` (subtask não entrou na branch do pai) ou `exit_code` (saída não-zero sem outra pista). Também vai como `exitReason` no evento `run.finished` das falhas genéricas. A UI mostra o motivo no card e no detalhe da task.

`run.pr` é a pull request aberta pela sessão quando o projeto tem `git.autoPR` ligado: ao terminar um run com `exit_code: 0` e `autoPush`, o servidor pergunta ao `gh` (`gh pr view <branch> --json url,number,state`) qual é a PR da branch da task e grava `{ url, number, state }` no frontmatter. Sem `gh` instalado/autenticado, ou sem PR aberta, o campo fica `null` e a UI não mostra o botão "Ver PR".

`status` ∈ `backlog | todo | doing | done | archived` e é **derivado da pasta** do arquivo — a pasta vence o frontmatter em caso de divergência.

`depends_on` (lista de ids de tasks) segura a task **na fila**: ela entra normalmente (respeitando prioridade), mas nenhum tick a inicia enquanto alguma dependência não estiver `done`/`archived` — ou registrada como concluída no ledger. Assim que a última dependência conclui, ela dispara no tick seguinte. Dependência apontando para um id inexistente é ignorada (um id morto travaria a fila para sempre). A decomposição encadeia as subtasks geradas em série, na ordem devolvida pelo modelo.

**Human request/response.** Quando o agente termina com uma seção `## Human Request` preenchida, a task volta para `todo/` com a tag `human-request` e fica fora do auto-pilot (a menos que o projeto tenha `autoDecide`: aí o orquestrador responde no lugar do humano e reenfileira — mesmo fluxo daqui para a frente). O humano responde pelo drawer (`POST .../human-response`), que grava a resposta em `## Human Response` e enfileira a task. No início do run seguinte, o runner **consome** o par: tira as duas seções do corpo, arquiva-as em `## Histórico de Human Requests` e — se a task tem `run.session_id` — invoca `claude --resume <session_id>` passando só a resposta como prompt, continuando a sessão anterior em vez de recomeçar do zero. Se o resume falhar (sessão expirada, id desconhecido), o runner cai automaticamente no run normal com o prompt completo (a pergunta e a resposta vão dentro dele) e registra o motivo em `## Log de erros`.

`scheduled_at` (ISO ou `null`) agenda a task: quando o horário chega, o servidor a enfileira sozinho — mesmo com o auto-pilot desligado — e zera o campo. Só vale para tasks em `backlog`/`todo` e sem a tag `blocked`; enquanto o horário está no futuro, o auto-pilot **não** enfileira a task. A resolução é a do ticker (20s), então o disparo pode atrasar até esse tanto — nunca adiantar.

## Rotas

### Geral

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok: true, claudeAvailable }` — `claudeAvailable` é falso se o CLI `claude` não estava no PATH no boot. |
| `GET` | `/api/usage` | — | Limites do plano Claude: `{ available: false }` ou `{ available: true, limits: [{ kind, percent, severity, resetsAt, isActive, model }] }`. `kind` ∈ `session | weekly_all | weekly_scoped`. Cache de 60s; qualquer falha vira `available: false`. |
| `GET` | `/api/models` | — | Catálogo de modelos: `{ models: [{ id, label }], fetchedAt, source }`. `source` ∈ `api | fallback` — `fallback` é a lista embutida no código, usada enquanto nunca se rodou um refresh. |
| `POST` | `/api/models/refresh` | — | Busca a lista oficial na Models API da Anthropic (`GET /v1/models`, com o token OAuth do Claude Code) e persiste em `~/.claude-kanban/models.json`. Devolve o mesmo shape de `GET /api/models`. **502** sem credencial do CLI ou se a API falhar — o catálogo anterior é mantido. |
| `POST` | `/api/pick-folder` | — | Abre o seletor nativo (macOS). `{ path }` (ou `path: null` se cancelado). **501** fora do macOS. |
| `GET` | `/api/suggestion-types` | — | `{ types: { melhoria: "…", correcao: "…", … } }` — chaves aceitas em `/analyze`. |

### Projetos

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | — | `{ projects: [project] }` |
| `POST` | `/api/projects/reorder` | `{ projectIds: ["id", …] }` | `{ projects }`. Ordem do rail (é a ordem persistida em `projects.json`): os ids recebidos vão primeiro, na ordem dada; projetos que não vieram mantêm a posição relativa no fim; ids desconhecidos são ignorados. **400** se `projectIds` não for array. |
| `POST` | `/api/projects` | `{ name, path, description?, create? }` | `{ project }`. Roda o bootstrap (pastas, `guard.mjs`, skill, hooks) e inicia o watcher. `create: true` cria o diretório se ele ainda não existir (projeto novo criado por integração externa, que não tem como dar `mkdir`). **400** se falta campo, o diretório não existe (e `create` não veio) ou não é gravável. Falha de bootstrap **não** falha a rota: aparece em `bootstrap: "failed"` + `bootstrapError`. |
| `PATCH` | `/api/projects/:projectId` | qualquer subconjunto de `{ name, skipPermissions, defaultModel, auxModel, autoRun, autoDecompose, autoDecide, reviewGate, goalBudgetUsd, enrichMode, rawMode, verifyCommand, timeoutMs, maxTurns, retry: { maxAttempts, backoffMinutes, escalateModels }, webhookUrl, webhookStatuses, devServer: { command, url }, git: {…}, stuckDetection, sandbox, visualCheck: { command, url }, autopilot: {…} }` | `{ project }`. `devServer` e `git` são merges rasos. `verifyCommand`: comando (testes/lint) rodado no worktree da task após um run com `exit 0`; se falhar, a task volta para `todo/` com a saída no `## Log de erros` e não entra no ledger. String vazia desliga. `enrichMode`: `"off" | "auto" | "always"` — política de enriquecimento da descrição na hora do run (**400** fora desses valores). `rawMode`: `"off" | "execute" | "plan" | "plan-execute"` (**400** fora disso) — fora de `off`, a task vai para o `claude -p` só com título + `## Descrição`, sem o prompt do kanban; `plan` roda em `--permission-mode plan` e grava o plano (input do `ExitPlanMode`, ou a resposta final) em `## Plano` e conclui; `plan-execute` depois retoma a mesma sessão (`--resume`) para executar o plano, sem contar nova tentativa; a resposta final da execução vira o `## Resultado`. `autoDecompose`: antes de executar, o Claude avalia cada task sem `decompose` próprio e desmembra a que for grande demais — encadeia no máximo `nivel:2` (as subtasks saem tagueadas com `nivel:N` e o último nível já nasce com `decompose: false`); `POST .../decompose` ignora esse teto, pedido explícito sempre desmembra. A task desmembrada **não** vai para `done/`: volta para `todo/` com a tag `decomposta` e `depends_on` = todas as filhas; quando elas concluem, roda como **integração** (o prompt lista o `## Resultado` de cada filha) na branch `kanban/<pai>` e é ela quem faz push/PR. Cada filha parte de `kanban/<pai>` (criada da base na primeira vez), não faz push, e ao concluir é mergeada nela pelo servidor (`merge-tree`, sem checkout; ganha a tag `integrada`; conflito ⇒ sessão de resolução, ver abaixo). Com `autoDecompose` ligado, uma task que esgota as tentativas (ou estoura `maxTurns`) é desmembrada uma vez — tag `replanejada` — em vez de virar `blocked`. `reviewGate`: depois do `verifyCommand`, uma sessão somente leitura no `auxModel` confere se o diff entrega o que a task pede; reprovação segue o caminho do verify reprovado (`verifyFailed: true`, `exit_reason: review_rejected`). `goalBudgetUsd`: teto em dólares por árvore (task raiz + descendentes, somando `run.total_cost_usd` de todas as tentativas); estourado, a task que ia rodar ganha `blocked` e sai `run.finished` com `exitCode: -1, exitReason: "goal_budget"`. `null`/vazio desliga. Tasks bem-sucedidas que deixam `## Aprendizados` têm a seção anexada em `.claude/claude-kanban/notes.md`, injetado (últimos 6 KB) no prompt das próximas; passando de 9 KB, o autopilot compacta o arquivo com o `auxModel` (no máximo 1x por hora). `autoDecide`: quando o agente termina com uma `## Human Request`, o próprio Claude responde (assumindo a opção que recomendou) e a task volta para a fila com a tag `auto-decided`, em vez de parar com a tag `human-request` — teto de 3 decisões automáticas por task; a decisão segue a spec/ADRs e é registrada pela sessão como novo ADR em `.claude/claude-kanban/spec/adr/`. Task desmembrada de nível 0 (ou com tag `sistema`) ganha antes das demais uma subtask com tag `desenho` que cria/atualiza `.claude/claude-kanban/spec/SPEC.md`; o prompt das execuções injeta resumo + seção relevante + lista de ADRs (até 6 KB). Ligar `autoRun` enfileira imediatamente tudo que está em `todo/` (exceto tasks com as tags `blocked` ou `human-request`). `maxTurns`: teto de turnos da sessão de execução (default `40`, máximo `500`); ao estourar, a task volta para `todo/` com a tag `blocked` e **sem** nova tentativa automática — repetir pararia no mesmo ponto pelo mesmo custo. `0` desliga o teto. `retry`: merge raso, `maxAttempts` de 1 a 10 (default `2`) e `backoffMinutes` de 0 a 1440 (default `10`); o backoff só vale com `autoRun` ligado. `auxModel`: modelo das sessões auxiliares somente leitura (desmembrar/enriquecer/analisar), default `claude-sonnet-5` — elas não herdam o `defaultModel` para não pagar preço de modelo caro por um JSON pequeno. `webhookUrl`: endpoint avisado quando uma task muda de status, um run falha ou um run pede humano (**400** se não começar com `http://`/`https://`); string vazia desliga. `webhookStatuses`: array de status (`backlog, todo, doing, done, archived`) que disparam `task_status_changed` — ex.: `["done"]` só avisa quando a task conclui (**400** se não for array ou trouxer status inválido); array vazio volta a avisar todos. Não afeta os demais eventos. `verifyCommand` que falha é comparado com o mesmo comando rodado na base da branch (worktree destacado, em cache por sha): falhas que a base já tinha não contam contra a task (o evento `verify` sai com `ok: true` e a nota), e as linhas novas vão para o topo do log. Conflito ao integrar numa task pai (ou no auto-merge) não bloqueia de cara: a task volta para `todo/` com a tag `conflito` e `run.merge_from` = branch a mergear, e a sessão seguinte faz o merge e resolve (teto de 2 rodadas por task, depois `blocked`). Numa branch já existente (retry, feedback de PR, conflito) o diff é sempre medido desde o merge-base com o ponto de partida, recalculado no fim da sessão. `retry.escalateModels`: lista de modelos da 2ª tentativa em diante (**400** com modelo desconhecido). `stuckDetection` (default ligado): mata a sessão que chama a mesma tool com o mesmo input 3x seguidas ou faz 40 chamadas sem Edit/Write — `exit_reason: stuck`, conta como tentativa. `sandbox`: passa `--settings` com o sandbox nativo do Claude Code (Bash confinado, rede só GitHub/registries, `allowUnsandboxedCommands: forbid`, `failIfUnavailable`). `visualCheck`: com `reviewGate`, sobe `command` no worktree, espera `url` responder, tira screenshot com `npx playwright screenshot` e o revisor lê a imagem. `autopilot` (merge raso; **400** com valor inválido): `prFollowUp` (CI vermelho/comentário novo na PR reabre a task com `## Feedback da PR`; 3 rodadas no máximo, depois evento `pr.attention`), `autoMerge: { enabled, maxLines (300), protectedPaths (['.github/**']) }` (exige `run.review_approved`; sem PR faz o merge local ao concluir, com PR faz `gh pr merge` quando os checks passam), `issuesLabel` + `issuesMinutes` (import periódico de issues), `watchMainCI` (run do Actions falhado na base vira task `urgent` com tag `ci:<sha>`), `suggestHours` + `suggestMax` (✨ Suggest agendado; tag `auto-sugestao`), `importStatus` (`backlog` ou `todo`), `digestHour` (0–23, webhook `daily_digest`) e `cleanup: { enabled (false), mode: "confirm" | "auto" (confirm), remote (false) }` (limpeza de branches `kanban/*` e worktrees órfãos — ver `/cleanup`; em `auto` roda 1x por hora, grava `autopilotState.cleanupLast` e as branches removidas entram no `daily_digest` como `cleanedBranches`; em `confirm` nada é removido sem o `POST`). O estado dos jobs fica em `project.autopilotState`. |
| `POST` | `/api/projects/:projectId/bootstrap` | — | `{ project }`. Re-roda o bootstrap (idempotente). |
| `GET` | `/api/projects/:projectId/plugins` | — | `{ scope, plugins: [{ key, label, description, marketplace, tokenImpact, tokenNote, enabled, installed }] }`. `enabled` é o que está salvo no projeto; `installed` é o que o CLI de fato tem — divergem quando um install falhou ou o plugin foi removido por fora. **409** se o CLI `claude` não estiver no PATH. |
| `PUT` | `/api/projects/:projectId/plugins` | `{ enabled: ["ponytail", …] }` | `{ scope, plugins, installed, removed, errors, project }`. Sincroniza: instala o que falta (`claude plugin marketplace add` + `claude plugin install`) e desinstala o que saiu da lista, sempre no escopo `local` (`.claude/settings.local.json` do projeto, fora do git e sem tocar no `~/.claude`). Não aborta no primeiro erro — instala o que dá e devolve o resto em `errors: [{ key, error }]`; só entra na config do projeto o que instalou de fato. Chaves válidas: `ponytail`, `claude-mem`, `obsidian-second-brain` (**400** fora disso). |
| `DELETE` | `/api/projects/:projectId?uninstallGuardrails=true` | — | `{ ok: true }`. Remove o projeto do app, esvazia a fila dele, para o dev server e o watcher. Com a query, também desinstala os hooks/guard do projeto. Não apaga tasks nem código. |

### Search sources

Fontes de busca customizadas do projeto (endpoints HTTP cadastrados pelo usuário). Persistem em `p.searchSources` no `~/.claude-kanban/projects.json` e aparecem no `project.searchSources`.

Formato: `{ id, name, method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", url, headers: [{ key, value }], queryParams: [{ key, value }], body, bodyType: "json"|"text"|"form", enabled, resultsPath, titleField, descriptionField, pollMinutes }`. `pollMinutes` (0–10080, default 0): com valor, o autopilot busca a fonte sozinho nesse intervalo e importa o que for novo em `autopilot.importStatus`.

A request é montada exatamente como cadastrada: os `queryParams` são **acrescentados** à query da `url`, os `headers` vão como estão e o `body` só é enviado quando o método não é `GET`/`DELETE` (nesse caso o `content-type` sai do `bodyType` — `application/json`, `text/plain` ou `application/x-www-form-urlencoded` — a menos que você já tenha declarado um header `content-type`).

Os três últimos mapeiam a resposta JSON da busca: `resultsPath` navega até o array de resultados (ex. `"data.items"`; vazio = a raiz), `titleField`/`descriptionField` apontam o campo de cada item (aceitam caminho com ponto, ex. `"fields.summary"`). Sem eles, cai nos nomes usuais (`title`/`name`/`subject` e `description`/`body`/`summary`/`content`); o link do item sai de `url`/`html_url`/`link`/`permalink`. Título é truncado em 200 chars e item sem título é descartado.

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/search-sources` | — | `{ searchSources: [...] }` |
| `POST` | `/api/projects/:projectId/search-sources` | `{ name, method?, url, headers?, queryParams?, body?, bodyType?, enabled? }` | `{ source, project }`. `id` é gerado. **400** se `name` vazio, `method`/`bodyType` fora do enum ou `url` não for http(s). Pares chave-valor sem `key` são descartados. |
| `PATCH` | `/api/projects/:projectId/search-sources/:sourceId` | qualquer subconjunto do body de criação | `{ source, project }`. Merge raso campo a campo (listas são substituídas por inteiro). **404** se a fonte não existe; mesmas validações do POST. |
| `DELETE` | `/api/projects/:projectId/search-sources/:sourceId` | — | `{ ok: true, project }`. **404** se a fonte não existe. |
| `POST` | `/api/projects/:projectId/search-sources/:sourceId/fetch` | — | `{ items: [{ sourceId, sourceName, title, description, url, tag, already_imported }] }`. Executa a request da fonte (máx. 100 itens, timeout 30s), inclusive se ela estiver desabilitada. **404** se a fonte não existe, **502** em erro de rede/HTTP ou resposta que não é JSON/array. |
| `POST` | `/api/projects/:projectId/search-sources/fetch-all` | — | `{ items: [...], errors: [{ sourceId, sourceName, error }] }`. Busca em todas as fontes `enabled` em paralelo; uma fonte fora do ar vira erro por fonte em vez de derrubar a busca. |
| `POST` | `/api/projects/:projectId/search-sources/import` | `{ items: [...], priority?, status? }` | `{ created: [task], skipped: [{ title, tag, reason }] }`. Cria uma task por item com as tags `search` e `search:<sourceId>:<hash>`, emitindo um `task.upserted` por task. Defaults: `priority: "medium"`, `status: "backlog"` (valores fora do enum caem no default). Item sem `sourceId`/`title` entra em `skipped` com `reason: "item inválido"`. **400** se `items` vazio. |

O dedupe usa a tag `search:<sourceId>:<hash(title+url)>` — do mesmo jeito que o import de issues usa `gh:<n>`. Buscar de novo devolve `already_imported: true` nos itens já importados, e o `import` recalcula a tag no servidor e ignora (via `skipped`) o que já virou task — o cliente manda o item, não a identidade dele.

A descrição da task criada é a descrição do item mais uma linha de referência (`Importada da fonte de busca **<nome>**: <link>`), para a sessão do Claude poder citar a origem.

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
| `GET` | `/api/projects/:projectId/spec` | — | `{ spec, adrs: [{ file, title, content }] }` — `SPEC.md` e os ADRs numerados (`NNNN-*.md`) do checkout principal, somente leitura. `spec: ""` quando não existe. |
| `GET` | `/api/projects/:projectId/cleanup` | — | `{ branches: [{ name, taskId, reason }], worktrees: [{ dir, taskId, reason }], last }`. Candidatos à limpeza: branch `kanban/*` contida na branch base (`reason: "merged"`) ou de task com tag `merged`/`integrada`/`discarded`; nunca de task em `backlog`/`todo`/`doing`, na fila/rodando, com PR aberta ou checada num worktree vivo (checkout principal incluso) — branch com trabalho não mergeado de task sem essas tags (ou que não existe mais) fica. Worktree em `~/.claude-kanban/worktrees/<projeto>/` sem sessão viva: `reason` `idle`, `task-gone` ou `missing` (diretório sumiu). `last`: `autopilotState.cleanupLast`. |
| `POST` | `/api/projects/:projectId/cleanup` | `{ branches?: [nomes], worktrees?: [dirs] }` | `{ branches, worktrees, errors }` — o que foi removido. Remove só o lote pedido que **ainda** é candidato (recalcula na hora); worktrees primeiro (com commit de segurança do que não estava commitado), depois as branches (remoção forçada, já que squash não deixa ancestral). Com `autopilot.cleanup.remote`, apaga também `origin/<branch>`. **400** se as listas não forem arrays de strings. Ação do servidor — o guard só proíbe a *sessão* de apagar branch. |

### Tasks

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/tasks` | — | `{ tasks: [task] }` |
| `POST` | `/api/projects/:projectId/tasks` | `{ title, description?, priority?, tags?, status?, model?, enrich?, decompose?, scheduled_at?, depends_on? }` | `{ task }`. Só `title` é obrigatório (**400** sem ele). Default: `priority: "medium"`, `status: "backlog"`. **400** se `scheduled_at` não é uma data ISO válida. **400** se `depends_on` referencia uma task inexistente ou fecha um ciclo de dependências. `model` (aqui, no PATCH da task e no `defaultModel` do projeto) tem que ser o **slug exato** de um modelo do catálogo vigente (`GET /api/models`) — é ele que vai para `claude --model`. Apelidos legados (`opus`, `sonnet`, `haiku`, `fable`) são convertidos no slug mais recente da família; qualquer outro valor dá **400**. |
| `GET` | `/api/projects/:projectId/tasks/:taskId` | — | `{ task }` — **404** se não existe. |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId` | subconjunto do frontmatter (`title`, `status`, `priority`, `tags`, `model`, `enrich`, `decompose`, `scheduled_at`, `depends_on`, `run`, `body`…) | `{ task }`. Mudar `status` move o arquivo de pasta e emite `task.moved`. `scheduled_at`: ISO agenda, `null`/`""` desagenda, lixo dá **400**. `depends_on`: lista de ids (`[]` limpa); **400** para id inexistente, auto-dependência ou ciclo. |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId` | — | `{ task }`. **Não apaga o arquivo**: move para `archived/`. |
| `POST` | `/api/projects/:projectId/tasks/:taskId/enrich` | `{ auto? }` | `{ enriched, reason, costUsd, task }`. Sessão headless read-only que reescreve a `## Descrição` (e possivelmente o título) para ficar mais clara e com contexto do código. Com `auto: true` o modelo só reescreve se julgar necessário (`enriched: false` caso contrário). **409** se a task está rodando ou o CLI `claude` não existe. |
| `POST` | `/api/projects/:projectId/tasks/:taskId/human-response` | `{ response }` | `{ task, queue }`. Responde à seção `## Human Request` deixada pelo agente: grava a resposta na seção `## Human Response`, remove a tag `human-request` e enfileira a task. **400** com `response` vazio; **404** se a task não existe; **409** se ela já está rodando/na fila ou o CLI `claude` não existe. |
| `GET` | `/api/projects/:projectId/tasks/:taskId/diff` | — | `{ diff }` — o patch unificado capturado ao fim do último run. **404** se a task não gerou diff. |

### Ações manuais (guardrails)

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/pending-actions` | — | `{ actions: [{ id: "pa-xxxxxx", timestamp, label, command, taskId, status }] }` — parse de `.claude/claude-kanban/pending-actions.md`. |
| `POST` | `/api/projects/:projectId/pending-actions/:actionId/resolve` | — | `{ actions }` (lista já atualizada). **404** se a ação não existe ou já foi resolvida. Emite `pending.updated`. |
| `POST` | `/api/projects/:projectId/pending-actions/:actionId/run` | — | `{ ...action, output, exitCode, error }` — executa o comando bloqueado no diretório do projeto (shell, timeout 120s, saída truncada em 20k). Não resolve a ação. **404** se a ação não existe. |

### Configuração do Claude no projeto

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/claude-config` | — | `{ files: [...] }` — metadados dos arquivos editáveis (`CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, skills, agents, hooks…), sem conteúdo. |
| `GET` | `/api/projects/:projectId/claude-config/file?path=<rel>` | — | Conteúdo do arquivo. **400** se o `path` estiver fora da allowlist. |
| `PUT` | `/api/projects/:projectId/claude-config/file` | `{ path, content }` | Grava o arquivo e emite `project.updated`. **400** em path inválido. |

### Extensões e plugins

Uma família de rotas só para os dois escopos: **sem** `projectId` o escopo é global (`~/.claude`), **com** `projectId` é `<projeto>/.claude`. `projectId` vai no query (GET) ou no body (POST). Projeto inexistente → **404**; diretório do projeto sumido → **409**. Toda mutação com escopo de projeto emite `project.updated`.

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `GET` | `/api/extensions?projectId=<id>` | — | `{ scope, root, items: { skills, agents, commands, hooks }, catalog }`. Cada item: `{ kind, name, enabled, title, description, path }` (hook tem `event` no lugar de `path`). |
| `POST` | `/api/extensions/install` | `{ id, projectId? }` | Instala um item do catálogo embutido (grava os arquivos, ou insere o hook em `settings.json`) e devolve a listagem nova. Reinstalar por cima **reativa** o que estava desativado. **400** em id desconhecido. |
| `POST` | `/api/extensions/toggle` | `{ kind, name, enabled, projectId? }` | Listagem nova. **400** se o item não existe ou o `kind`/`name` é inválido. |
| `POST` | `/api/extensions/remove` | `{ kind, name, projectId? }` | Listagem nova. Apaga em ambos os estados (ativo e desativado). **400** se não existe. |
| `GET` | `/api/plugins?refresh=true` | — | `{ installed: [...], available: [{ id, name, description, marketplace, installCount }] }` via `claude plugin list --json --available`. Cache de 60s; `refresh=true` força. **503** sem o CLI, **502** se o CLI falhar. |
| `POST` | `/api/plugins/:action` | `{ id, projectId? }` | `action` ∈ `install\|uninstall\|enable\|disable`. `{ ok: true, output }`. **503** sem o CLI, **400** em ação/id inválido ou falha do comando. |

`kind` ∈ `skills|agents|commands|hooks`. `name` de skill/agent/command casa `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (barra e `..` são rejeitados — o nome vira caminho); `name` de hook é `<evento>:<sha1 curto do conteúdo>`, id estável que não muda ao ativar/desativar e não colide entre dois hooks do mesmo evento.

Desativar skill/agent/command move para `<kind>-disabled/` no mesmo escopo (o Claude Code não varre essa pasta). Desativar hook tira a entrada de `settings.json` e guarda em `~/.claude-kanban/disabled-hooks.json`, chaveado por escopo.

### Análise (sugestão de tasks)

| Método | Path | Body | Resposta |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/analyze` | `{ types?: ["melhoria", …], question?: "…", report?: true }` | `{ report, suggestions: [{ title, description, type, priority }], costUsd }`. Roda uma sessão headless read-only. Sem `types` (ou vazio), o Claude decide o foco sozinho; `question` (≤2000 chars) é uma pergunta livre que as sugestões devem responder; `report: true` pede também um parecer em markdown (visão geral, pontos fortes, o que refaria, próximos passos, ideias de produto) — senão `report` vem `""`. **409** se o CLI `claude` não existe; **500** em falha da análise. As sugestões **não** viram tasks sozinhas — cabe ao cliente `POST /tasks` as escolhidas. |

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
| `run.started` | `{ projectId, taskId, pid, resumedFrom }` | Sessão `claude -p` iniciou. `resumedFrom` é o `session_id` continuado (`claude --resume`) quando o run está entregando uma resposta humana a uma sessão anterior; `null` num run normal. |
| `run.log` | `{ projectId, taskId, event }` | Uma linha do `--output-format stream-json` da sessão. `event` é o objeto do próprio Claude Code (`assistant`, `user`, `result`…); linhas não-JSON viram `{ type: "raw", text }`. Este é o evento de alto volume. |
| `run.finished` | `{ projectId, taskId, exitCode, humanRequest?, maxTurns?, costUsd, durationMs, numTurns, sessionId, pr? }` | Sessão terminou (sucesso, erro ou timeout). `exitCode: 0` ⇒ task foi para `done/` e registrada no ledger — exceto se o agente deixou uma seção `## Human Request` preenchida: nesse caso `humanRequest: true`, a task volta para `todo/` com a tag `human-request` (fora do auto-pilot) e aguarda decisão do humano — com `autoDecide` no projeto vem também `autoDecided: true`, a resposta é escrita pelo orquestrador, a task volta para a fila e nenhum webhook `human_request` é disparado; qualquer outro valor ⇒ volta para `todo/` e o motivo é anexado ao "## Log de erros" da task. `maxTurns: true` ⇒ o teto de turnos do projeto estourou: a task volta para `todo/` com a tag `blocked`, sem retentativa automática. `exitCode: -1` também cobre falha ao preparar o workspace git. `pr` é `{ url, number, state }` da PR aberta pela sessão (`autoPR`), ou `null` — o mesmo valor gravado em `run.pr` no frontmatter. `conflictResolving: true` ⇒ a task conflitou ao integrar e já voltou para a fila para resolver. `exitReason: "stuck"` ⇒ a detecção de sessão travada encerrou o run. |
| `pr.attention` | `{ projectId, taskId, url, reason }` | O acompanhamento de PR desistiu (feedback demais). Vira o webhook `pr_needs_human`. |
| `run.killed` | `{ projectId, taskId }` | Sessão morta manualmente (`/api/run/kill`). A task volta para `todo/` e **não** re-entra sozinha na fila, mesmo com auto-run ligado. |
| `run.dequeued` | `{ projectId, taskId }` | Task cancelada antes de começar (`/api/run/dequeue`): saiu da fila. Vem seguido de um `run.queue`. |
| `run.queue` | `queueView` | A fila foi alterada por fora do fluxo normal (remoção de um projeto, cancelamento de um item da fila). |
| `pending.updated` | `{ projectId, actions }` | `pending-actions.md` mudou (guardrail bloqueou algo, ou uma ação foi resolvida). |
| `devserver.updated` | `{ projectId, running, pid, startedAt, exitCode? }` | Dev server iniciou ou morreu. `exitCode` só aparece quando o processo terminou. |
| `project.updated` | `{ projectId }` | Algo do projeto mudou fora do board (checkout de branch, escrita em claude-config, CRUD de search source). Sinal de "refaça o `GET /api/projects`". |

## `~/.claude-kanban/` (ou `$CLAUDE_KANBAN_HOME`)

Todo o estado global do app é arquivo — não há banco de dados.

```
~/.claude-kanban/
├── projects.json          # { projects: [...] } — os projetos cadastrados (id, path, git, devServer, flags)
├── state.json             # { queue: [{projectId, taskId}], maxConcurrency } — a fila sobrevive a restarts
├── ledger.json            # { executed: { <taskId>: { exitCode: 0, completedAt, sessionId } } }
├── models.json            # catálogo de modelos baixado da Models API (opcional)
├── disabled-hooks.json    # hooks desativados pela tela de extensões, por escopo
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
