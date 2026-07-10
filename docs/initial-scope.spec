# SPEC — claude-kanban (gerenciador de tasks para Claude Code)

> App local (React + Node) que gerencia tasks de múltiplos projetos como arquivos `.md` dentro de `.claude/claude-kanban/tasks/` de cada projeto, e executa essas tasks em sessões headless do Claude Code (`claude -p`), uma por vez, com log ao vivo no board. Ao cadastrar um projeto, o app faz **bootstrap** de hooks de segurança (guardrails determinísticos), skill de workflow e estrutura de pastas.

---

## 1. Visão geral

- **Fonte da verdade:** filesystem. O kanban é uma camada visual sobre arquivos `.md`.
- **Multi-projeto:** o usuário cadastra projetos informando o diretório raiz. Cada projeto tem seu próprio board.
- **Execução:** botão "Executar" no card dispara `claude -p` com `cwd` do projeto. Fila global com **1 sessão ativa por vez**. Cada task roda em sessão nova e isolada (equivalente a `/clear` automático).
- **Guardrails:** hooks PreToolUse instalados no bootstrap bloqueiam ações proibidas de forma determinística (independente do que o modelo "decida"). Ações bloqueadas que precisam de humano viram itens em "Ações manuais pendentes" na UI.
- **Fechamento:** ao concluir, o próprio Claude enriquece o arquivo da task (resumo, decisões, arquivos alterados, contexto para memória) e o backend move o arquivo para `done/` com metadados de execução.

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node 20+, Fastify, `@fastify/websocket` |
| Watcher | `chokidar` v4 |
| Frontmatter | `gray-matter` |
| Runner | `child_process.spawn` de `claude -p --output-format stream-json --verbose` |
| Guard dos hooks | script Node (`guard.mjs`), sem dependências externas |
| Frontend | React + Vite, `@dnd-kit` (drag and drop), Tailwind |
| Estado local do app | `~/.claude-kanban/projects.json` + `~/.claude-kanban/state.json` |

Sem banco de dados. Tudo é arquivo.

## 3. Estrutura criada em cada projeto (bootstrap)

```
<projeto>/.claude/
├── claude-kanban/
│   ├── tasks/
│   │   ├── backlog/
│   │   ├── todo/
│   │   ├── doing/
│   │   ├── done/
│   │   └── archived/
│   ├── hooks/
│   │   └── guard.mjs          # guardrails (ver §11)
│   ├── pending-actions.md     # fila de ações manuais para o humano (ver §11.4)
│   └── meta.json              # { "kanbanVersion": "x.y.z", "bootstrappedAt": ... }
├── skills/
│   └── claude-kanban/
│       └── SKILL.md           # workflow de tasks (ver §12)
└── settings.json              # hooks registrados via deep-merge (ver §10)
```

- Nome do arquivo de task: `<slug-do-titulo>--<id-curto>.md` (ex.: `refatorar-pipeline-rag--k7x2.md`). O slug pode mudar se o título for editado; o `id` **nunca** muda.
- Namespace `claude-kanban/` dentro de `.claude/` evita colisão com outras ferramentas e agrupa tudo que é do app.

## 4. Schema da task (`.md` com frontmatter YAML)

```yaml
---
id: k7x2m9            # nanoid(6), imutável, identidade da task
title: Refatorar pipeline de RAG
status: todo          # backlog | todo | doing | done | archived
priority: high        # low | medium | high | urgent
tags: [rag, backend]
created_at: 2026-07-10T14:32:00-03:00
updated_at: 2026-07-10T15:10:00-03:00
# ---- preenchidos pelo runner ----
run:
  session_id: null
  started_at: null
  completed_at: null
  exit_code: null
  cost_usd: null
  duration_ms: null
  num_turns: null
  attempts: 0
---

## Descrição

O que precisa ser feito, critérios de aceite, contexto, links.

## Resultado
<!-- Preenchido pelo Claude ao concluir: resumo, decisões, arquivos alterados, contexto para memória -->

## Log de erros
<!-- Preenchido pelo backend em caso de falha -->
```

## 5. Regra de sincronização dupla (pasta + status)

O status existe em **dois lugares**: na pasta onde o arquivo está e no campo `status` do frontmatter. Regras:

1. **Toda mudança de status feita pelo app** executa atomicamente: (a) atualiza `status` e `updated_at` no frontmatter, (b) move o arquivo para a pasta correspondente. Nessa ordem (escreve, depois `fs.rename`).
2. **Reconciliação em caso de divergência** (arquivo mexido manualmente ou pelo Claude Code): **a pasta vence**. Watcher detecta arquivo em `done/` com `status: doing` → corrige o frontmatter para `done`.
3. **Exceção:** `status` inválido/ausente → normalizar para o status da pasta.
4. Na inicialização e no cadastro de projeto, rodar reconciliação completa (scan de todas as pastas).

## 6. Registro de projetos

`~/.claude-kanban/projects.json`:

```json
{
  "projects": [
    {
      "id": "p1",
      "name": "TakeFlow AI",
      "path": "/home/mateus/dev/takeflow",
      "createdAt": "...",
      "skipPermissions": false
    }
  ]
}
```

- Validação ao cadastrar: diretório existe, é gravável. Cadastro dispara o **bootstrap** (§9).
- `skipPermissions` (default `false`): flag por projeto que, quando ligada, faz o runner passar `--dangerously-skip-permissions` em **todas** as sessões do projeto (§14.2). Toggleável a qualquer momento pela UI (§15) via `PATCH /api/projects/:projectId`. Os guardrails determinísticos (hooks PreToolUse com `deny`) continuam valendo mesmo com a flag ligada — ver racional em §10.
- Remover projeto do app **não** apaga nada no projeto (nem tasks, nem hooks). Oferecer botão separado "desinstalar guardrails" que reverte o merge no `settings.json` e remove `.claude/claude-kanban/` (com confirmação dupla).

## 7. API REST (Fastify)

```
GET    /api/projects
POST   /api/projects                 { name, path }        # dispara bootstrap
PATCH  /api/projects/:projectId      { name?, skipPermissions? }   # edita config do projeto
POST   /api/projects/:projectId/bootstrap                  # re-roda bootstrap (upgrade de hooks)
DELETE /api/projects/:projectId

GET    /api/projects/:projectId/tasks
POST   /api/projects/:projectId/tasks              { title, description, priority, tags, status? }
GET    /api/projects/:projectId/tasks/:taskId
PATCH  /api/projects/:projectId/tasks/:taskId      # status → move de pasta
DELETE /api/projects/:projectId/tasks/:taskId      # move para archived/ (nunca deleta)

GET    /api/projects/:projectId/pending-actions
POST   /api/projects/:projectId/pending-actions/:actionId/resolve   # marca como feita pelo humano

POST   /api/projects/:projectId/tasks/:taskId/run
POST   /api/run/kill
GET    /api/run/queue
POST   /api/run/queue/reorder                      { taskIds: [...] }
```

## 8. WebSocket (eventos servidor → cliente)

```
task.upserted     { projectId, task }
task.moved        { projectId, taskId, from, to }
task.removed      { projectId, taskId }
pending.updated   { projectId, actions }           # fila de ações manuais mudou
run.queued        { projectId, taskId, position }
run.started       { projectId, taskId, pid }
run.log           { projectId, taskId, event }     # evento stream-json bruto
run.finished      { projectId, taskId, exitCode, costUsd, durationMs, numTurns, sessionId }
run.killed        { projectId, taskId }
```

## 9. Bootstrap do projeto

Executado no cadastro e re-executável a qualquer momento (**idempotente**). Passos:

1. `mkdir -p` de toda a estrutura de §3.
2. Grava/atualiza `hooks/guard.mjs` (comparando `kanbanVersion` em `meta.json` — se a versão do app for maior, sobrescreve o guard e atualiza o meta).
3. **Deep-merge** dos hooks no `.claude/settings.json` (§10). Nunca sobrescrever o arquivo: parsear o existente, mesclar, gravar. Hooks do app são identificáveis pelo path `.claude/claude-kanban/hooks/` no campo `command` — o merge remove/atualiza só esses e preserva todos os demais.
4. Grava/atualiza `skills/claude-kanban/SKILL.md` (§12).
5. Garante `pending-actions.md` (cria vazio se não existir; nunca sobrescreve conteúdo).
6. Adiciona `.claude/claude-kanban/pending-actions.md` e `meta.json` ao `.gitignore` do projeto se houver git (tasks são versionáveis por decisão do usuário; pending-actions é estado local).
7. Reconciliação completa pasta↔status.

Se `settings.json` existir mas for JSON inválido: **abortar** o merge, marcar projeto como `bootstrap_failed` na UI com a mensagem de parse, nunca tentar "consertar" o arquivo do usuário.

## 10. Registro dos hooks em `.claude/settings.json`

Bloco mesclado (formato de hooks do Claude Code — evento `PreToolUse`, matcher por tool, handler `command`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|Grep|Glob",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/claude-kanban/hooks/guard.mjs\" file" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/claude-kanban/hooks/guard.mjs\" bash" }
        ]
      }
    ]
  }
}
```

Racional: hooks PreToolUse com `deny` bloqueiam a ferramenta **antes** da checagem de permissões — funcionam mesmo com `--permission-mode acceptEdits` (que o runner usa) e até sob bypass. É garantia determinística, não instrução que o modelo pode ignorar.

## 11. `guard.mjs` — guardrails

Script Node único, sem dependências, que lê o JSON do evento no stdin (`tool_name`, `tool_input`, `cwd`) e responde por stdout com exit 0. Para **negar**:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<motivo — vira feedback para o Claude>" } }
```

Para permitir: exit 0 sem JSON. Nunca misturar exit code 2 com JSON (JSON só é processado em exit 0).

### 11.1 Regra A — Nunca ler/expor `.env`

- **Modo `file`** (Read/Edit/Write/Grep/Glob): deny se `tool_input.file_path` (ou `path`/`pattern`) casar `(^|/)\.env(\..+)?$`, **exceto** `.env.example` e `.env.template`.
- **Modo `bash`:** deny se o comando referenciar arquivo `.env` em contexto de leitura/escrita (`cat`, `less`, `head`, `tail`, `grep`, `sed`, `awk`, `cp`, `source`, redirecionamento, `echo ... >> .env` etc.). Regex sobre o comando + tokens; mesma exceção para `.example`/`.template`.
- Reason: `"Leitura de .env bloqueada por política do projeto. Use variáveis já carregadas no ambiente ou peça ao humano o valor necessário."`

### 11.2 Regra B — Nunca commitar/pushar em main/master

- Modo `bash`: se o comando contiver `git commit`, o guard executa `git -C <cwd> branch --show-current`; se o branch atual for `main` ou `master` → deny com reason `"Commit direto em <branch> é proibido. Crie um branch de trabalho (git checkout -b ...) e commite nele."`
- Também deny para: `git push` com destino explícito `main`/`master` (`git push origin main`, `git push origin HEAD:main`), qualquer `git push --force`/`-f` para main/master, e `git merge`/`git rebase` **executados com main/master como branch atual** (proteção contra merge local direto).
- `git checkout main`, `git pull` em main, leitura: permitidos.

### 11.3 Regra C — Nunca deletar branch

- Deny para: `git branch -d|-D|--delete`, `git push --delete <remote> <branch>`, `git push <remote> :<branch>`, `git worktree remove` com `--force`.
- Reason: `"Deleção de branch é ação exclusivamente humana. Registre a solicitação e siga em frente."` O guard também registra a ação em `pending-actions.md` (§11.4).

### 11.4 Regra D — Nunca deletar arquivos fora do escopo do projeto

- Modo `bash`: para comandos destrutivos (`rm`, `rmdir`, `unlink`, `shred`, `find ... -delete`, `git clean` com paths), o guard extrai os paths alvo, resolve cada um com `path.resolve(cwd, target)` e compara com o root do projeto (`realpath` de `$CLAUDE_PROJECT_DIR`).
  - Alvo **dentro** do projeto → permitido (permissões normais do Claude Code se aplicam).
  - Alvo **fora** do projeto (ou contendo `~`, `$HOME`, path absoluto externo, ou `..` que escape do root após resolução) → **deny** + registro em `pending-actions.md`.
- Casos que sempre negam sem análise: `rm` com `-rf` cujo alvo resolva para `/`, `$HOME`, ou o próprio root do projeto.
- Reason: `"Deleção fora do escopo do projeto bloqueada. A solicitação foi registrada em pending-actions para execução manual pelo humano. Continue a task sem essa deleção."`

**Mecânica do `pending-actions.md`:** o guard appenda um bloco:

```md
## [pa-<nanoid>] 2026-07-10T16:02:11-03:00 — deletar arquivo externo
- comando bloqueado: `rm /home/mateus/tmp/dump.sql`
- task: k7x2m9 (se CLAUDE_KANBAN_TASK_ID estiver no env — o runner injeta)
- status: pending
```

O watcher observa esse arquivo e emite `pending.updated`; a UI mostra badge no projeto e painel com botão "marcar como resolvido" (muda `status: pending` → `done` no bloco). Como a reason do deny é devolvida ao Claude como feedback, ele fica ciente e relata no `## Resultado` da task o que ficou pendente de ação humana — os dois canais se complementam.

### 11.5 Precedência e testes

- Se múltiplos hooks responderem, `deny` sempre vence `allow` — os guards do app nunca são enfraquecidos por outros hooks do usuário.
- `guard.mjs` deve ter suíte de testes própria (`node --test`) cobrindo cada regra com comandos reais de ataque: `cat .env`, `git commit` em main, `git branch -D feature`, `rm -rf ~/x`, `rm ../../etc/passwd`, `find / -name '*.log' -delete`, e os falsos positivos (`cat .env.example`, `git commit` em feature branch, `rm ./tmp/cache.json`).

**Limite honesto (documentar no README):** guard por regex/parsing de comando não é sandbox. Comandos ofuscados (variáveis, base64, scripts intermediários) podem escapar. Os guardrails cobrem o caso realista de o modelo tentar a ação diretamente; para isolamento forte, rodar o projeto em container/worktree.

## 12. Skill `claude-kanban` (workflow de tasks)

`SKILL.md` instalado no bootstrap, ensinando o Claude Code (em qualquer sessão no projeto, não só nas disparadas pelo kanban) a trabalhar com o sistema:

- Onde as tasks vivem (`.claude/claude-kanban/tasks/`), o schema do frontmatter e o significado das pastas.
- **Nunca** alterar frontmatter nem mover arquivos de task de pasta — isso é papel do orquestrador.
- Ao concluir trabalho relacionado a uma task, preencher `## Resultado` com: resumo, decisões técnicas e porquês, arquivos criados/alterados, contexto para memória futura, pendências humanas (citando os ids de `pending-actions.md`).
- Como criar uma task nova quando o humano pedir "adiciona isso no backlog": criar `.md` em `backlog/` **sem** frontmatter `id` (o watcher adota e completa — §13).
- Políticas do projeto (espelho das regras dos hooks, para o modelo nem tentar): não ler `.env`, não commitar em main/master, não deletar branches, não deletar fora do projeto.

## 13. Watcher (chokidar)

- Um watcher por projeto sobre `<path>/.claude/claude-kanban/tasks/**/*.md` **e** `pending-actions.md`, `awaitWriteFinish: { stabilityThreshold: 300 }`.
- **Ignorar escritas próprias:** `Set` de `path:mtime` das escritas do backend nos últimos 2s; eventos que casem são descartados.
- `add`/`change` → parsear frontmatter, reconciliar (§5), emitir `task.upserted`.
- `unlink` + `add` do mesmo `id` em outra pasta em <1s → tratar como move (`task.moved`).
- Arquivos sem frontmatter/`id`: adotar — gerar `id`, inferir `status` da pasta, gravar frontmatter mínimo.
- Mudança em `pending-actions.md` → parsear blocos, emitir `pending.updated`.

## 14. Runner (execução via Claude Code headless)

### 14.1 Fila

- Fila global FIFO (reordenável), **concorrência = 1**. Persistida em `~/.claude-kanban/state.json`.
- Ao enfileirar: task em `backlog/` move para `todo/`. Ao iniciar: move para `doing/`, grava `run.started_at`, `run.attempts += 1`.

### 14.2 Spawn

```js
spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  // permissões: acceptEdits por padrão; se project.skipPermissions, troca por --dangerously-skip-permissions
  ...(project.skipPermissions
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'acceptEdits']),
  // opcional por projeto: '--allowedTools', 'Read,Edit,Write,Bash(npm *),Bash(git *)'
], {
  cwd: project.path,
  env: { ...process.env, CLAUDE_KANBAN_TASK_ID: task.id }  // guard usa para vincular pending-actions
})
```

- **Timeout configurável** (default 30min): SIGTERM → SIGKILL após 10s. Task volta para `todo/` com nota em `## Log de erros`.
- **`--dangerously-skip-permissions` é opcional por projeto** (flag `skipPermissions`, §6), controlado por um toggle na UI (§15). Padrão **desligado** → runner usa `--permission-mode acceptEdits`. Quando ligado, o runner passa `--dangerously-skip-permissions` em toda sessão do projeto. Racional de segurança: os guardrails são hooks `PreToolUse` com `deny`, que bloqueiam a ferramenta **antes** da checagem de permissões e valem **mesmo sob bypass** (§10) — as regras críticas (§11) continuam ativas independentemente da flag. A flag só suprime os prompts de permissão do restante das ferramentas.
- Parsear stdout linha a linha (NDJSON) → `run.log`. Do evento final `result`: `session_id`, `total_cost_usd`, `duration_ms`, `num_turns`.

### 14.3 Template do prompt

```
Você vai executar a task abaixo, definida no arquivo {taskRelPath} deste projeto.
Siga a skill "claude-kanban" deste projeto para o workflow de tasks.

<task>
{conteúdo completo do .md}
</task>

Instruções obrigatórias ao concluir:
1. Edite {taskRelPath}, seção "## Resultado": resumo do que foi feito, decisões
   técnicas e porquês, arquivos criados/alterados, contexto para memória futura
   e pendências que exigem ação humana (cite os ids de pending-actions.md).
2. NÃO altere o frontmatter e NÃO mova o arquivo de pasta — o orquestrador faz isso.
3. Se uma ação sua for bloqueada pelos guardrails do projeto, não tente contornar:
   registre no Resultado e siga com o restante da task.
4. Se não conseguir concluir, escreva em "## Resultado" o que foi tentado,
   onde travou e o que falta.
```

### 14.4 Pós-execução

- `exit 0` → metadados no frontmatter, status → `done`, move para `done/`, `run.finished`.
- `exit != 0` ou timeout → metadados gravados, erro em `## Log de erros`, volta para `todo/`. `run.attempts >= 3` → tag `blocked`, fila não re-aceita automaticamente.
- Próxima task inicia automaticamente (sessão nova ⇒ contexto limpo por construção).

### 14.5 Crash recovery

No boot do backend: task em `doing/` sem processo ativo → volta para `todo/` com nota "execução interrompida (restart do orquestrador)".

## 15. Frontend

- **Sidebar:** projetos + cadastro (nome + path). Badges: tasks em `doing`/fila e **ações manuais pendentes** (destaque, ex. âmbar).
- **Board:** 5 colunas (Backlog, To Do, Doing, Done, Archived — colapsável). Drag and drop chama `PATCH status`.
- **Card:** título, prioridade, tags, custo/duração se executada. Em execução: spinner, "Ver log", "Matar sessão".
- **Painel de log:** drawer com stream de `run.log` (texto do assistant + tools chamadas; JSON bruto em modo debug). Eventos de deny dos guardrails destacados em vermelho.
- **Painel "Ações manuais":** lista de blocos de `pending-actions.md` com comando bloqueado, task de origem e botão "resolvido".
- **Fila global:** barra no rodapé com task ativa + próximas, reorder por drag.
- **Editor de task:** modal com título, prioridade, tags e corpo markdown (preview).
- **Status do bootstrap:** indicador por projeto (ok / desatualizado / falhou) com botão "re-rodar bootstrap".
- **Toggle "Skip permissions" (por projeto):** switch nas configurações do projeto que liga/desliga `skipPermissions` (§6) via `PATCH /api/projects/:projectId`. Quando ligado, todas as sessões do projeto rodam com `--dangerously-skip-permissions`. Exibir com destaque de aviso (ex. âmbar/vermelho) e microcópia curta esclarecendo que os guardrails determinísticos (não ler `.env`, não commitar em main, etc.) continuam ativos. A mudança vale para as **próximas** sessões enfileiradas; sessões já em execução não são afetadas.

## 16. Edge cases

- **Duas instâncias do app:** lockfile em `~/.claude-kanban/lock` (PID). Segunda instância aborta.
- **Claude edita a própria task durante o run:** watcher emite `task.upserted` normal — card atualiza ao vivo.
- **ID duplicado** (copy/paste): watcher regenera o `id` do arquivo mais novo, loga aviso.
- **Path do projeto sumiu:** projeto `unavailable`, watcher pausado, nada deletado.
- **`claude` fora do PATH:** checar no boot (`claude --version`), aviso na UI.
- **`settings.json` com hooks conflitantes do usuário:** merge preserva tudo; deny de qualquer hook prevalece, então não há como o merge enfraquecer política existente.
- **Upgrade do app:** `meta.json.kanbanVersion` < versão do app → UI marca "bootstrap desatualizado"; re-rodar atualiza guard + skill sem tocar tasks.

## 17. Features adicionais adotadas

### 17.1 Agent profiles (presets de execução)

Preset = conjunto nomeado de flags do `claude -p`. Globais em `~/.claude-kanban/profiles.json`, com override por projeto (`defaultProfileId` no registro do projeto) e por task (`profile` no frontmatter, opcional).

```json
{
  "profiles": [
    {
      "id": "prof-default",
      "name": "Padrão",
      "model": null,                      // null = default do CLI; ou "opus", "sonnet", ...
      "permissionMode": "acceptEdits",    // acceptEdits | plan | bypassPermissions
      "allowedTools": null,               // ex.: "Read,Edit,Write,Bash(npm *),Bash(git *)"
      "planning": false                   // true → prefixa o prompt pedindo plano antes de executar
    }
  ]
}
```

- Resolução no spawn: task.profile → project.defaultProfileId → perfil global padrão.
- `permissionMode: bypassPermissions` equivale ao toggle `skipPermissions` (§6) — o toggle passa a ser um atalho para esse campo do perfil efetivo; guardrails de §11 seguem valendo.
- API: `GET/POST/PATCH/DELETE /api/profiles`, campo `profile` aceito em `POST/PATCH` de task e `defaultProfileId` em `PATCH /api/projects/:projectId`.
- UI: seletor de perfil no editor de task e nas configurações do projeto.

### 17.2 Tags/@snippets reutilizáveis em prompts

- Biblioteca global de snippets em `~/.claude-kanban/snippets.json`: `{ "id", "name", "body" }`.
- Na descrição da task, `@nome-do-snippet` é expandido pelo runner ao montar o prompt (substituição textual, no template de §14.3). O `.md` da task guarda o `@ref`, não o texto expandido — snippets atualizados valem para execuções futuras.
- `@ref` inexistente: não bloqueia; o runner mantém o texto literal e loga aviso.
- API: `GET/POST/PATCH/DELETE /api/snippets`. UI: autocomplete de `@` no editor de task + tela de gerenciamento de snippets.

### 17.3 Repository scripts (setup + dev server por projeto)

Dois scripts opcionais por projeto, no registro (§6):

```json
{ "setupScript": "npm i && cp .env.example .env", "devScript": "npm run dev" }
```

- **setupScript:** executado pelo runner ao preparar um worktree novo (quando execução em worktree estiver habilitada) — resolve `npm i`, cópia de `.env`, etc. Falha do setup aborta o run com erro em `## Log de erros`.
- **devScript:** dá o botão **"Abrir preview"** no projeto/card — spawna o script (cwd do projeto ou do worktree), detecta a porta no stdout quando possível e exibe link. Um dev server por projeto por vez; botão vira "Parar preview".
- API: campos em `PATCH /api/projects/:projectId`; `POST /api/projects/:projectId/dev-server/start|stop`. Eventos WS: `devserver.started|stopped|log`.

### 17.4 Notificações

- Notificação de desktop (via `node-notifier` ou equivalente) + badge na UI para: `run.finished` (sucesso ou falha), task marcada `blocked` (3 tentativas), novo item em `pending-actions.md`.
- Config global em `~/.claude-kanban/state.json` (`notifications: { enabled, onSuccess, onFailure, onPendingAction }`), toggle nas configurações do app.
- Racional: o fluxo é despachar a task e ir fazer outra coisa — o app avisa quando terminou ou precisa de atenção.

### 17.5 List view + filtros/busca

- Alternativa ao board: tabela com colunas título, projeto, status, prioridade, tags, custo, atualização.
- Filtros por status/prioridade/tags/projeto + busca textual (título e corpo). Client-side sobre o estado já sincronizado — sem API nova.
- Toggle board/lista persistido em `state.json`.

### 17.6 "Open in editor" (VS Code)

- Botão no card/projeto que abre o arquivo da task ou o diretório do projeto no editor: `code <path>` (fallback: URL `vscode://file/<path>`).
- Comando configurável globalmente (`editorCommand`, default `code`) para suportar outros editores.
- API: `POST /api/open-in-editor { path }` (validado contra os roots dos projetos cadastrados — nunca abre path arbitrário).

## 18. Fases de implementação

1. **F1 — Core filesystem:** schema, CRUD via API escrevendo `.md`, estrutura de pastas, reconciliação pasta↔status.
2. **F2 — Bootstrap + guardrails:** guard.mjs com suíte de testes, merge de settings.json, skill, pending-actions.
3. **F3 — Watcher + WebSocket:** sync bidirecional ao vivo, adoção de arquivos crus, pending.updated.
4. **F4 — UI:** sidebar, board, drag and drop, editor, painel de ações manuais.
5. **F5 — Runner:** fila, spawn headless, stream de log, pós-execução, crash recovery.
6. **F6 — Polimento:** timeout/attempts/allowedTools por projeto, painel de custos agregado, desinstalação de guardrails, notificações (§17.4), list view + filtros/busca (§17.5), open in editor (§17.6).
7. **F7 — Execução avançada:** agent profiles (§17.1), @snippets (§17.2), repository scripts + preview (§17.3).

## 19. Critérios de aceite

- Cadastrar projeto cria toda a estrutura de §3, mescla hooks no `settings.json` preservando conteúdo pré-existente, e re-rodar o bootstrap não duplica nada.
- Numa sessão do Claude Code no projeto (interativa ou headless): `cat .env` e `Read` de `.env` são negados; `cat .env.example` passa; `git commit` em `main` é negado e em `feature/x` passa; `git branch -D x` é negado e aparece em "Ações manuais"; `rm /tmp/fora.txt` é negado, aparece em "Ações manuais" com o comando exato, e `rm ./src/tmp.txt` passa.
- Criar task na UI gera `.md` correto; editar o `.md` externamente reflete na UI em <1s; drag entre colunas move arquivo **e** frontmatter; move manual de arquivo corrige o frontmatter (pasta vence).
- Executar task roda `claude -p` no diretório do projeto com log ao vivo; ao fim, `## Resultado` preenchido e arquivo em `done/` com custo/duração/session_id.
- Com o toggle "Skip permissions" **desligado** (padrão), o runner usa `--permission-mode acceptEdits`; **ligado**, a sessão roda com `--dangerously-skip-permissions`. Em ambos os modos, os guardrails de §11 (`.env`, commit em main, deleção de branch, deleção fora do escopo) permanecem negados.
- Duas tasks em sequência nunca compartilham sessão/contexto; matar sessão devolve task para `todo/` com log; restart do backend não deixa task órfã em `doing/`.
- Suíte de testes do `guard.mjs` verde, incluindo falsos positivos.
- Task com `profile` roda com as flags do perfil resolvido (model, permission mode, allowedTools); sem perfil, cai no default do projeto e depois no global.
- `@snippet` na descrição é expandido no prompt enviado, mas o `.md` da task preserva o `@ref`; `@ref` inexistente não bloqueia a execução.
- Com `devScript` configurado, "Abrir preview" sobe o servidor e "Parar preview" o mata; `setupScript` roda antes da task em worktree novo e falha do setup aborta o run com log.
- `run.finished` e novo item em pending-actions disparam notificação de desktop quando habilitadas.
- List view filtra por status/prioridade/tags/projeto e busca por texto; toggle board/lista persiste entre sessões.
- "Open in editor" abre o arquivo da task no VS Code e rejeita paths fora dos projetos cadastrados.
