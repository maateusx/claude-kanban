# Funcionalidades do claude-kanban

O claude-kanban é um gerenciador de tarefas local para o Claude Code: um quadro kanban visual (React) sobre arquivos `.md` puros, onde cada task é executada por uma sessão headless do Claude (`claude -p`), com log ao vivo, isolamento por git worktree e revisão humana por diff. Sem banco de dados — o filesystem é a fonte da verdade.

**Arquitetura**: monorepo npm workspaces — `server/` (Fastify + watcher + runner, porta 4400) e `web/` (React + Vite + Tailwind + dnd-kit, porta 5544). Estado global em `~/.claude-kanban/` (`projects.json`, `state.json`, `ledger.json`, `worktrees/`).

---

## Gestão de projetos e tasks

### 1. Registro e bootstrap de projeto
Registra um projeto (nome + pasta) e instrumenta o repositório automaticamente: cria as pastas de status, instala `guard.mjs` e a skill `SKILL.md`, faz merge idempotente dos hooks `PreToolUse` no `.claude/settings.json` (preservando o conteúdo do usuário), instala templates de exemplo e ajusta o `.gitignore`. Detecta versão desatualizada e reinstala; desinstalação limpa tudo. (`server/src/lib/bootstrap.js`, `server/src/routes/projects.js`)

### 2. Filesystem como fonte da verdade
Cada task é um arquivo `.md` com frontmatter YAML (id, title, status, priority, tags, timestamps, bloco `run`) e seções `## Descrição`, `## Resultado`, `## Log de erros`. O status vive na pasta (`backlog/todo/doing/done/archived`); quando pasta e frontmatter divergem, a pasta vence. (`server/src/lib/tasks.js`)

### 3. Watcher de arquivos ao vivo
Um watcher (chokidar) por projeto reflete no board, em tempo real, edições manuais dos `.md` — inclusive detectando move entre pastas como mudança de status. Ignora as escritas do próprio servidor. (`server/src/lib/watcher.js`)

### 4. Templates de task
Criação de tasks a partir de modelos `.md` por projeto (`.claude/claude-kanban/task-templates/`). Exemplos instalados: `bug-report.md`, `feature.md`. (`server/src/lib/templates.js`)

### 5. Importação de issues do GitHub
Cria tasks a partir de issues via `gh issue list`, com dedupe pela tag `gh:<n>` (reimportar não duplica) e link para a issue na descrição. (`server/src/lib/github.js`)

### 6. Fontes de busca customizadas (search sources)
N endpoints HTTP por projeto viram origem de tasks. Cada fonte é uma request totalmente customizável — método (`GET`…`DELETE`), URL, headers, query params e body (`json`/`text`/`form`) — mais o mapeamento da resposta JSON: `resultsPath` (caminho até o array, ex. `data.items`), `titleField` e `descriptionField` (aceitam caminho com ponto; sem eles vale o fallback `title`/`name`/`subject` e `description`/`body`/`summary`/`content`, com o link vindo de `url`/`html_url`/`link`/`permalink`). Máximo 100 itens por busca, timeout de 30 s.

Pelo menu do projeto: **Fontes de busca** abre o CRUD (criar, editar, ativar/desativar, remover, com confirmação) e **Buscar tasks (fontes customizadas)** abre o modal de busca — escolhe-se uma fonte ou "todas as habilitadas", os resultados vêm com checkbox e o import cria um card no Backlog por item selecionado. Numa busca em todas as fontes, uma fonte fora do ar vira um erro por fonte em vez de derrubar a busca inteira.

O dedupe é por tag `search:<sourceId>:<hash(title+url)>` (mesmo contrato do `gh:<n>` do GitHub): item já importado volta com `already_imported` e aparece desabilitado na lista; o servidor recalcula a tag no import e ignora o que já virou task. As fontes ficam em `projects.json` (`project.searchSources`). (`server/src/lib/searchSources.js`, `server/src/lib/searchFetch.js`, `server/src/routes/search-sources.js`, `web/src/SearchSources.jsx`)

### 7. Sugestão de tasks por análise (✨ Suggest)
Uma sessão headless somente-leitura analisa o projeto e sugere até 12 tasks acionáveis (melhoria, correção, feature, refatoração, teste, documentação); o humano escolhe quais viram cards no backlog. (`server/src/lib/analyzer.js`)

### 8. Enriquecimento de descrição (enrichMode)
Reescreve a descrição da task para deixá-la clara e acionável — sob demanda pela UI ou automaticamente na hora do run, conforme `enrichMode` do projeto (`off`/`auto`/`always`) ou override por task. (`server/src/lib/enricher.js`)

### 9. Decomposição de tasks
Quebra uma task grande em 2–8 subtasks encadeadas por `depends_on` (tags `subtask`/`pai:<id>`) — sob demanda ou automaticamente (`autoDecompose`). (`server/src/lib/decomposer.js`)

## Execução

### 10. Fila global e runner
Fila FIFO persistida (sobrevive a restart), com inserção por prioridade, reorder manual e kill. Cada task roda em sessão `claude -p` isolada com `--output-format stream-json`, modelo escolhido por task > projeto > default, timeout configurável (default 30 min), teto de turnos configurável (`--max-turns`, default 40, 0 desliga) e concorrência configurável (default 1, teto 8 — concorrência real exige worktree). (`server/src/lib/runner.js`)

### 11. Log de execução ao vivo
Eventos da sessão são gravados em `.claude/claude-kanban/logs/<id>.jsonl` e transmitidos por WebSocket para o drawer da UI, com replay da última execução. (`runner.js`)

### 12. Auto-run (auto-pilot)
Com `autoRun` ligado, tudo que entra em `todo` é enfileirado automaticamente, respeitando ordem do board, dependências, agendamentos e ignorando tasks `blocked`/`human-request`. (`server/src/index.js`)

### 13. Dependências entre tasks
`depends_on` garante ordem de execução: a fila só libera uma task quando as dependências estão `done`/`archived`. Validação impede ciclos e auto-dependência. (`runner.js`, `routes/tasks.js`)

### 14. Agendamento
`scheduled_at` por task (entra sozinha na fila quando vence) e pausa da fila do projeto até um horário (`queuePausedUntil`), via ticker de 20 s. (`server/src/lib/scheduler.js`)

### 15. Pausa global e modo drenar
Pausa toda a plataforma sem matar sessões ativas: nada novo sai da fila, runs em andamento terminam. Pausa indefinida ou com prazo. (`runner.js`)

### 16. Gate de verificação pós-run
`verifyCommand` por projeto (testes/lint) roda após o exit 0; se falhar, a task volta para `todo` e conta como tentativa. (`runner.js`)

### 17. Retentativas com backoff
`retry.maxAttempts` (default 3) e `retry.backoffMinutes` por projeto; esgotadas as tentativas, a task ganha a tag `blocked`. (`runner.js`)

### 18. Ledger de idempotência
Só sucessos entram no `ledger.json`; caminhos automáticos nunca re-executam uma task já registrada (evita loops quando o status na pasta se perde). Um run pedido explicitamente por humano limpa o registro. (`server/src/lib/ledger.js`)

### 19. Recuperação de crash
Após restart, tasks presas em `doing` sem processo voltam para `todo` (ou reconciliam para `done` se estão no ledger). (`runner.js`)

## Segurança e controle humano

### 20. Guardrails determinísticos
Hooks `PreToolUse` (`guard.mjs`) bloqueiam ações perigosas mesmo sob skip-permissions: leitura/escrita de `.env`, commit/push/merge em `main`/`master`, deleção de branches, deleção de arquivos fora do projeto e `rm -rf` de paths críticos. Limite honesto: é parsing/regex, não sandbox. (`server/templates/guard.mjs`)

### 21. Ações manuais (pending-actions)
Ações bloqueadas pelos guardrails viram itens em `pending-actions.md` para um humano resolver; a UI lista, permite executar o comando bloqueado (a saída aparece no próprio item) e marcar como resolvido. (`server/src/lib/pending.js`)

### 22. Human Request / Human Response
O agente pode pausar por decisão humana escrevendo `## Human Request`; o card volta para `todo` com a tag `human-request` (fora do auto-pilot). O humano responde pela UI e a sessão retoma via `claude --resume` (com fallback de re-execução levando pergunta e resposta no prompt). (`runner.js`)

### 23. Skill claude-kanban
`SKILL.md` instalado em cada projeto instrui a sessão: schema da task, preenchimento de `## Resultado`, criação de tasks no backlog e as políticas de guardrails. (`server/templates/SKILL.md`)

### 24. Segurança de rede
Allowlist de Origin e checagem de Host localhost contra CSRF/DNS-rebinding (crítico para um servidor local que executa código), mais lockfile de instância única. (`server/src/app.js`, `SECURITY.md`)

## Git e revisão

### 25. Integração Git / worktrees
Cada task roda numa branch `kanban/<taskId>`; com `useWorktree`, em worktree isolado em `~/.claude-kanban/worktrees/`. Opções por projeto: `baseBranch`, `pullBeforeStart`, `autoPush`, `autoPR` etc. Ao terminar: auto-commit de segurança, captura de diff (teto 2 MB, exclui metadados do kanban) e cleanup preservando a branch. (`server/src/lib/git.js`)

### 26. Aprovar / descartar por diff
O humano revisa o diff na UI e aprova (merge `--no-ff` na base, com abort seguro em conflito) ou descarta (apaga só a branch local). Tags `merged`/`discarded` registram o desfecho. (`server/src/routes/git.js`)

### 27. Auto-PR
Com `autoPush` + `autoPR`, a sessão abre a PR via `gh pr create` e a plataforma captura a URL no bloco `run` (botão na UI). (`git.js`)

## Observabilidade e conveniência

### 28. Painel de custos
Agrega custo (USD), duração e turnos por dia/modelo/status a partir dos blocos `run` dos `.md`, em janela configurável. (`server/src/lib/stats.js`)

### 29. Widget de uso do plano Claude
Mostra limites e uso da conta (sessão de 5h e semanais) lendo o token OAuth local. (`server/src/lib/usage.js`)

### 30. Editor de configuração do Claude Code
Ver e editar, pela UI, os arquivos de config do projeto: settings, MCP, hooks, skills, agents, commands e `CLAUDE.md`, com validação de path. (`server/src/lib/claudeConfig.js`)

### 31. Dev servers por projeto
Inicia/para o servidor de desenvolvimento do projeto pela UI, com buffer de logs e abertura da URL. (`server/src/lib/devservers.js`)

### 32. Catálogo de modelos
Escolha de modelo por task/projeto, com normalização de aliases legados (`opus`, `sonnet`…) para o slug oficial mais recente da família. O catálogo vem da Models API da Anthropic (`GET /v1/models`, autenticada com o login do Claude Code) pelo botão **atualizar modelos** nas configurações globais, e fica em `~/.claude-kanban/models.json`; sem refresh, vale a lista embutida no código. (`server/src/lib/models.js`, `web/src/models.js`)

### 33. UI React completa
Board com drag-and-drop (dnd-kit), colunas por status, filtros por tag, ordenação configurável, drawer de log, visualização de diff, notificações do sistema e sons. (`web/src/`)

---

## Fluxo de trabalho típico

1. `npm run dev` → abrir `localhost:5544` → registrar o projeto (bootstrap automático).
2. Criar tasks manualmente, por template, via ✨ Suggest, importando issues do GitHub ou buscando nas fontes customizadas do projeto.
3. (Opcional) Enriquecer descrição, desmembrar em subtasks, definir prioridade, modelo, agendamento e dependências.
4. Executar (arrastar para `todo` ou ligar auto-run) — cada task em branch/worktree isolado, com log ao vivo.
5. Guardrails bloqueiam o perigoso (vira ação manual); decisões viram Human Request.
6. Gate de verificação roda antes de `done`; falhas re-tentam com backoff até `blocked`.
7. Revisar o diff e aprovar (merge) ou descartar; PR opcional automática.
8. Acompanhar custos e uso do plano nos painéis.

## Diferenciais

- **Tasks são `.md` legíveis e editáveis** — sem banco, sem lock-in; a pasta vence divergências.
- **Guardrails determinísticos via hooks nativos**, valendo até sob skip-permissions.
- **Isolamento por worktree** com auto-commit de segurança → concorrência real e descarte sem risco.
- **Ledger de idempotência** contra loops de re-execução.
- **Human-in-the-loop de verdade**: Human Request/Response com retomada de sessão, revisão por diff antes do merge.
- **Auto-pilot completo**: auto-run, auto-decompose, enrich, retry com backoff, agendamento e gate de verificação.
