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
Uma sessão headless somente-leitura analisa o projeto e sugere até 12 tasks acionáveis (melhoria, correção, feature, refatoração, teste, documentação) — ou deixa o Claude escolher o foco, opcionalmente guiado por uma pergunta livre. Pode também devolver um parecer do projeto (pontos fortes, o que refaria, próximos passos, ideias de produto); o humano escolhe quais viram cards no backlog. (`server/src/lib/analyzer.js`)

### 8. Enriquecimento de descrição (enrichMode)
Reescreve a descrição da task para deixá-la clara e acionável — sob demanda pela UI ou automaticamente na hora do run, conforme `enrichMode` do projeto (`off`/`auto`/`always`) ou override por task. (`server/src/lib/enricher.js`)

### 9. Decomposição de tasks
Quebra uma task grande em 2–8 subtasks encadeadas por `depends_on` (tags `subtask`/`pai:<id>`) — sob demanda ou automaticamente (`autoDecompose`). (`server/src/lib/decomposer.js`)

A task desmembrada vira um **objetivo**: volta para `todo` com a tag `decomposta`, dependendo de todas as filhas, e roda por último como **integração** — confere o conjunto contra a descrição original, roda build/testes, corrige as costuras e faz o push/PR. As filhas partem da branch `kanban/<pai>` e, ao concluir, o servidor as mergeia nela (tag `integrada`), então a 2ª subtask já enxerga o código da 1ª. Conflito nessa integração vira uma sessão de resolução (17g). O decomposer devolve um **grafo** (`depends_on` por subtask, posições a partir de 1): subtasks sem dependência entre si rodam em paralelo, cada uma no seu worktree (teto de `maxConcurrency`), partindo de `kanban/<pai>` com o que as dependências já integraram. Havendo partes paralelizáveis, a 1ª subtask é a de **contratos** (interfaces, tipos, stubs, rotas vazias) e as paralelas dependem dela. O grafo é ordenado topologicamente; ciclo, índice inválido ou resposta sem `depends_on` fazem a decomposição cair para série (cada uma depende da anterior). Com a subtask de desenho, as raízes do grafo passam a depender dela. As irmãs integram no pai uma de cada vez (o `finish` é síncrono); quem conflita com o que a irmã já integrou vai para a sessão de resolução. (`dependencyGraph` em `server/src/lib/decomposer.js`) O card do objetivo mostra o progresso (`✂ 3/5 subtasks`) e o custo somado da árvore.

## Execução

### 10. Fila global e runner
Fila FIFO persistida (sobrevive a restart), com inserção por prioridade, reorder manual e kill. Cada task roda em sessão `claude -p` isolada com `--output-format stream-json`, modelo escolhido por task > projeto > default, timeout configurável (default 30 min), teto de turnos configurável (`--max-turns`, default 40, 0 desliga) e concorrência configurável (default 1, teto 8 — concorrência real exige worktree). (`server/src/lib/runner.js`)

Modo cru (`rawMode` no projeto): em vez do prompt do kanban, a sessão recebe só título + descrição, como se alguém colasse a task no Claude Code do terminal. Três variantes: só executar, só planejar (plan mode; o plano vai para `## Plano`) e planejar + executar (retoma a sessão do plano para executá-lo). A resposta final vira o `## Resultado`.

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

Com `autoDecompose` ligado, em vez de `blocked` a task é **replanejada** uma vez: desmembrada levando o log de erros como contexto (tag `replanejada`). Na segunda vez, `blocked`.

### 17b. Revisão automática (`reviewGate`)
Depois do gate de verificação, uma sessão somente leitura no modelo auxiliar lê a task, o `## Resultado` e o diff e responde se o trabalho entrega o que foi pedido. Reprovou: a task volta para `todo` com o feedback no log de erros, contando tentativa. Revisor fora do ar não reprova. (`server/src/lib/reviewer.js`)

### 17c. Teto de custo por objetivo (`goalBudgetUsd`)
O custo de cada task acumula em `run.total_cost_usd` (todas as tentativas, decomposição e revisão). Com o teto ligado, a árvore que o ultrapassa para: a próxima task ganha `blocked` e o webhook avisa (`run_failed`).

### 17d. Aprendizados entre tasks
A sessão registra o que descobriu de não óbvio numa seção `## Aprendizados`; o orquestrador junta tudo em `.claude/claude-kanban/notes.md` e injeta nos prompts seguintes — a subtask 4 não repete o erro da 2. Quando o arquivo passa de 9 KB, o autopilot o compacta com o modelo auxiliar (junta duplicatas, descarta o que foi contradito), em vez de só cortar o começo.

### 17d2. Spec e ADRs como fonte da verdade
Cada projeto pode ter `.claude/claude-kanban/spec/SPEC.md` (resumo do sistema + uma seção `## ` por módulo com responsabilidades e contratos) e `spec/adr/NNNN-titulo.md` (decisões). Ao contrário do `notes.md`, a spec é **versionada**: as sessões a escrevem no worktree e ela chega às tasks seguintes pelo git (o worktree não recebe a cópia do checkout principal). Objetivo grande — task desmembrada de nível 0, ou com a tag `sistema` — ganha uma primeira subtask `desenho` que cria/atualiza a spec antes das demais. O prompt de execução injeta o resumo, a seção que mais combina com a task e a lista de ADRs (teto de 6 KB); a integração confere o código contra a spec e a atualiza. Com `autoDecide`, a decisão sai da spec/ADRs e vira um novo ADR, para tasks futuras não decidirem o contrário. Leitura na UI pelo menu do projeto → "Spec e ADRs do sistema". (`server/src/lib/spec.js`)

### 17d3. Critérios de aceite como teste
O "pronto" vira resultado de teste. A subtask `desenho` também escreve os testes de aceite (e2e/integração) dos critérios do objetivo, em skip, e registra o comando numa seção `## Comando de aceite` do arquivo dela; ao concluir, o servidor grava esse comando em `acceptance_command` no frontmatter do objetivo. Na integração, o objetivo (ou qualquer task com `acceptance_command`; o `acceptanceCommand` do projeto vale para objetivos sem comando próprio) roda o comando depois do `verifyCommand` — falhou, volta para `todo` como verify reprovado. Tasks com a tag `bug` precisam registrar em `## Teste de reprodução` o comando de um teste que reproduz o bug: o servidor exige que ele passe na branch e **falhe na base**, rodando-o no worktree destacado do verify de referência com os arquivos de teste do diff copiados (sem isso, "arquivo não existe" contaria como reprodução). Sem seção, ou passando na base, a task volta com esse feedback. Os dois resultados vão para o `reviewGate` como evidência. (`runner.js`, `decomposer.js`, `reviewer.js`)

### 17e. Verify de referência
Quando o `verifyCommand` falha, o mesmo comando roda na base de onde a branch saiu, num worktree destacado (em cache por commit). Se a base já falhava igual, a falha não conta contra a task; se a task trouxe falhas novas, elas vão destacadas no topo do log. Um teste quebrado na `main` deixa de consumir as tentativas de todo mundo. (`runner.js`, `git.js`)

### 17f. Escalação de modelo e sessão travada
`retry.escalateModels` troca o modelo nas retentativas (a 2ª usa o primeiro da lista, a 3ª o segundo…). E a detecção de sessão travada (`stuckDetection`, ligada por padrão) observa o stream e encerra a sessão que chama a mesma tool com o mesmo input 3 vezes seguidas ou faz 40 chamadas sem editar arquivo — `exit_reason: stuck`, conta como tentativa.

### 17g. Resolução de conflito
Conflito ao integrar uma subtask na branch do pai (ou no auto-merge na base) não vira `blocked` de cara: a task volta para a fila com a tag `conflito` e `run.merge_from`, e a sessão seguinte recebe a instrução de mergear aquela branch, resolver, rodar os testes e commitar. Duas rodadas por task; depois disso, humano. Numa branch retomada (retry, feedback de PR, conflito) o diff é sempre medido desde o ponto de partida, recalculado no fim — o que veio da base num merge não conta como trabalho da task.

### 17h. Auto-merge por política
`autopilot.autoMerge` (`enabled`, `maxLines`, `protectedPaths`) deixa o trabalho entrar sem aprovação humana quando a revisão automática aprovou, o diff é pequeno e não toca caminho protegido (default `.github/**`). Sem PR, o merge local acontece ao concluir; com PR, o autopilot roda `gh pr merge` quando os checks passam. A task vai para `archived` com a tag `merged`.

### 17h-2. Fila de merge
Branches que passam sozinhas podem quebrar juntas. Tudo que entra na base pelo auto-merge local e toda subtask que integra no pai passa por uma fila serializada (estilo bors), um item por vez: o servidor calcula o merge com a ponta atual do destino (`merge-tree`, sem checkout), roda o `verifyCommand` num worktree destacado em cima do resultado (pulado quando é fast-forward — a árvore é a que o gate da task já testou; falhas que o destino já tinha não contam) e só então grava. Se o destino andou durante o verify, o item volta para o fim da fila. Conflito ou verify reprovado ⇒ a task volta com a tag `conflito` e `run.merge_from` (a mesma resolução da 17g). Enquanto uma subtask está na fila, o pai não parte. A fila fica em `state.json` (`mergeQueue`), é retomada no restart e aparece na barra de fila da UI (`⇢`, com "verificando merge" durante o verify). Com PR, o autopilot mergeia uma PR por rodada; PR atrás de `origin/<base>` recebe `gh pr update-branch` e só é mergeada depois que o CI passa de novo em cima da base.

**Revert automático.** O sha de cada merge do autopilot fica em `run.merge_sha`. Com `watchMainCI`, se o run que falhou na base é exatamente esse merge, o autopilot faz o revert na branch `kanban/revert-<id>` — merge local ⇒ o revert é mergeado na base do mesmo jeito; PR ⇒ push da branch e PR de revert aberta (evento `task.attention`, um humano mergeia) — e reabre a task com a tag `revertido`, a cauda do log e as instruções para trazer o trabalho de volta (`git merge` da base + `git revert` do revert). Uma vez por task; se o revert falhar, cai na task `urgent` de CI de sempre. Decisão: ADR 0001. (`server/src/lib/runner.js`, `server/src/lib/autopilot.js`)

### 17i. Acompanhamento de PR
Com `autopilot.prFollowUp`, o autopilot consulta as PRs abertas pelas tasks a cada 3 min: check vermelho (com a cauda do log do Actions), comentário novo (inclusive de linha; bots de fora) ou conflito com a base devolvem a task para a fila com uma seção `## Feedback da PR`. A sessão corrige e dá push na mesma branch. PR mergeada por fora arquiva a task. Depois de 3 rodadas, o webhook `pr_needs_human` chama um humano. (`server/src/lib/autopilot.js`)

### 17j. Trabalho que chega sozinho
O autopilot também puxa trabalho: issues com uma label (`issuesLabel` a cada `issuesMinutes`), fontes de busca com `pollMinutes`, run do Actions falhado na branch principal (`watchMainCI` → task `urgent`, tag `ci:<sha>`) e o ✨ Suggest agendado (`suggestHours`, com teto `suggestMax` de sugestões abertas). Tudo entra em `autopilot.importStatus` (`backlog` ou `todo`) com dedupe por tag.

Manutenção agendada (`autopilot.maintenance`): para cada tipo — `cobertura` (áreas sem teste), `lint` (código morto, duplicação), `dependencias` (atualizações que valem a pena) e `docs` (README.md por módulo com propósito, arquivos, contratos e armadilhas, que as próximas tasks leem como contexto) — há um intervalo `hours` (0 = desligado, default) e um teto `max` (default 2) de tasks abertas (`backlog`/`todo`/`doing`) com a tag `manutencao:<tipo>`. Vencido o intervalo e com vaga, o autopilot roda o analyzer do ✨ Suggest (somente leitura, `auxModel`) com a pergunta do tipo, restrito a um tipo de sugestão (`teste`, `refatoracao`, `melhoria`, `documentacao`); cada sugestão nova vira task em `importStatus` com as tags `<tipo de sugestão>`, `manutencao` e `manutencao:<tipo>`, com dedupe por título contra todas as tasks do projeto. Sem vaga, o modelo nem é chamado. Como a sessão é somente leitura, `dependencias` só enxerga o que está declarado nos manifestos/lockfiles (não roda `npm outdated`). (`MAINTENANCE_TYPES` em `server/src/lib/autopilot.js`)

### 17j2. Loop de objetivo até a spec estar cumprida
Com `autopilot.gapLoop: { enabled, maxRounds (3) }`, quando um objetivo (task raiz com a tag `decomposta`) conclui a integração, o runner marca `run.gap_pending` e o autopilot roda uma sessão somente leitura no `auxModel`, num worktree destacado da branch `kanban/<objetivo>` (ou da base, se ela já foi mergeada e removida), comparando `SPEC.md`/ADRs e os critérios de aceite com o código e os testes. A resposta tem o formato do ✨ Suggest. Cada lacuna vira task (tags `lacuna`, `pai:<objetivo>` e o tipo), encadeada em série e criada em `autopilot.importStatus`, com dedupe por título entre as filhas do objetivo; o objetivo volta para `todo` dependendo delas (`run.gap_rounds` +1) e integra de novo quando concluírem. Para quando não há lacunas (tag `spec-cumprida`), quando só sobram lacunas que já têm task, ao atingir `maxRounds` ou o `goalBudgetUsd` (este checado antes da auditoria) — nesses três casos sai o evento `goal.attention` / webhook `goal_needs_human` com a lista do que falta. O custo da auditoria soma no `run.total_cost_usd` do objetivo. (`server/src/lib/autopilot.js`, `findGaps` em `server/src/lib/analyzer.js`)

Com `autopilot.diagnose: { enabled }` (default desligado), a task que esgota as tentativas (e o replanejamento único) não fica simplesmente `blocked`: uma sessão somente leitura no `auxModel` lê `## Log de erros`, `run.exit_reason`, `## Resultado`, o diff salvo e a lista de tasks abertas, e classifica a causa. A ação depende dela: `ambiente` cria uma task pré-requisito `urgent` (tag `diagnostico`) e a adiciona ao `depends_on`; `flaky` repete o `verifyCommand` num worktree destacado da branch da task — passou, nova tentativa; falhou, cria a task `urgent` (tag `flaky`) de correção/quarentena do teste e espera por ela; `spec_ambigua` grava uma `## Human Response` de auto-decisão (decide pela spec/ADRs e registra um ADR, tag `auto-decided`); `grande_demais` marca `decompose: true`, que desmembra de novo mesmo acima de `nivel:2`; `falta_dependencia` adiciona ao `depends_on` a task aberta apontada (ou cria a task com o que falta); `externo` (credencial/conta/dinheiro) mantém `blocked` e emite `task.attention` / webhook `task_needs_human`. Fora de `externo`, a task volta para `todo` sem `blocked` e com `run.attempts` zerado. Toda task diagnosticada ganha a tag `diagnosticada:<causa>` e uma linha no `## Log de erros`; o custo soma no `run.total_cost_usd`, `run.diagnoses` conta as rodadas (teto de 2 por task — depois, `blocked` de vez) e as causas aparecem em `autonomy.byDiagnosis` das métricas. Falha da sessão de diagnóstico deixa a task `blocked`. (`server/src/lib/diagnoser.js`, `Runner.diagnose` em `server/src/lib/runner.js`)

### 17k. Sandbox e checagem visual
`sandbox` passa ao `claude -p` o sandbox nativo do Claude Code: Bash confinado em filesystem e rede (só GitHub e registries), sem fallback para fora do sandbox e falhando se ele não estiver disponível — a camada que os guardrails por regex não são. `visualCheck` (`command` + `url`) faz a revisão automática subir a app a partir do worktree, tirar um screenshot com o Playwright e conferir a parte visual.

### 17l. Resumo diário
Com `autopilot.digestHour` e `webhookUrl`, uma vez por dia sai o webhook `daily_digest`: o que concluiu, o que travou, o que espera decisão e o gasto das últimas 24h.

### 17m. Limpeza de branches e worktrees
`autopilot.cleanup` (`enabled`, `mode: confirm | auto`, `remote`) remove as branches `kanban/<id>` que já não guardam nada único — contidas na branch principal, ou de tasks com tag `merged` (squash no GitHub), `integrada` (estão na branch do pai) ou `discarded` — e os worktrees que sobraram de sessões mortas (com commit de segurança antes). Nunca toca task em backlog/a fazer/em andamento, na fila, com PR aberta, nem trabalho não mergeado de task sem essas tags. Em `confirm`, as Configurações do projeto listam os candidatos e o humano remove o lote marcado; em `auto`, o autopilot limpa 1x por hora e o resumo diário lista as branches. `remote: true` apaga também no `origin`. É o servidor quem apaga — a sessão continua proibida pelo guard. (`server/src/lib/git.js`, `server/src/lib/autopilot.js`)

### 18. Ledger de idempotência
Só sucessos entram no `ledger.json`; caminhos automáticos nunca re-executam uma task já registrada (evita loops quando o status na pasta se perde). Um run pedido explicitamente por humano limpa o registro. (`server/src/lib/ledger.js`)

### 19. Recuperação de crash
Após restart, tasks presas em `doing` sem processo voltam para `todo` (ou reconciliam para `done` se estão no ledger). (`runner.js`)

## Segurança e controle humano

### 20. Guardrails determinísticos
Hooks `PreToolUse` (`guard.mjs`) bloqueiam ações perigosas mesmo sob skip-permissions: leitura/escrita de `.env`, commit/push/merge em `main`/`master`, deleção de branches, deleção de arquivos fora do projeto e `rm -rf` de paths críticos. Limite honesto: é parsing/regex, não sandbox. (`server/templates/guard.mjs`)

### 21. Ações manuais (pending-actions)
Ações bloqueadas pelos guardrails viram itens em `pending-actions.md` para um humano resolver; a UI lista, permite executar o comando bloqueado (a saída aparece no próprio item) e marcar como resolvido. (`server/src/lib/pending.js`)

**Política de guardrail** (`guardrailPolicy`, editável em Configurações → Autonomia, um padrão por linha; `*` = qualquer trecho): a cada `pending.updated`, o servidor executa sozinho, com o mesmo "Executar comando", toda ação pendente cujo comando casa **inteiro** com um padrão, e grava no item `status: done`, a regra, o exit e a saída (indentada). O painel lista essas execuções. O agente continua bloqueado — o `guard.mjs` não muda; só o orquestrador executa, e essas ações não disparam o webhook `pending_action`. Nunca casa: comando com metacaracteres de shell (`;`, `&`, `|`, `<`, `>`, `$`, crase, barra invertida, aspas, `*`, `?`, parênteses ou quebra de linha), comando que toca `.env` (mesma regra do guard) e push/commit/merge na branch principal (regras do guard + push que cite o `baseBranch`). Default: `git branch -d kanban/*` — o `-d` só apaga branch já mergeada; o git recusa as outras e o item fica resolvido com a falha na saída. Lista vazia: tudo vai para o humano. Decisão: ADR 0002.

### 22. Human Request / Human Response
O agente pode pausar por decisão humana escrevendo `## Human Request`; o card volta para `todo` com a tag `human-request` (fora do auto-pilot). O humano responde pela UI e a sessão retoma via `claude --resume` (com fallback de re-execução levando pergunta e resposta no prompt). (`runner.js`)

Com `autoDecide` ligado no projeto, ninguém precisa responder: o prompt já manda o agente decidir sozinho, e se ele perguntar mesmo assim o orquestrador escreve a `## Human Response` ("assuma a opção que você recomendou") e devolve a task para a fila. O card decidido sozinho ganha a tag `auto-decided` (badge "🤖 decidido sozinho" no board e no detalhe) — rastro, não estado: não sai do auto-pilot. Depois de 3 decisões automáticas na mesma task o card volta a esperar um humano — perguntar e responder a si mesmo custa uma sessão por volta. (`runner.js`)

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
Agrega custo (USD), duração e turnos por dia/modelo/status a partir dos blocos `run` dos `.md`, em janela configurável. Métricas de autonomia: taxa de tasks que passam de primeira, % que precisou de humano, custo por task concluída (somando tentativas), quantas foram mergeadas e por que os runs pararam. (`server/src/lib/stats.js`)

### 29. Widget de uso do plano Claude
Mostra limites e uso da conta (sessão de 5h e semanais) lendo o token OAuth local. (`server/src/lib/usage.js`)

### 30. Editor de configuração do Claude Code
Ver e editar, pela UI, os arquivos de config do projeto: settings, MCP, hooks, skills, agents, commands e `CLAUDE.md`, com validação de path. (`server/src/lib/claudeConfig.js`)

### 31. Dev servers por projeto
Inicia/para o servidor de desenvolvimento do projeto pela UI, com buffer de logs e abertura da URL. (`server/src/lib/devservers.js`)

### 32. Catálogo de modelos
Escolha de modelo por task/projeto, com normalização de aliases legados (`opus`, `sonnet`…) para o slug oficial mais recente da família. O catálogo vem da Models API da Anthropic (`GET /v1/models`, autenticada com o login do Claude Code) pelo botão **atualizar modelos** nas configurações globais, e fica em `~/.claude-kanban/models.json`; sem refresh, vale a lista embutida no código. (`server/src/lib/models.js`, `web/src/models.js`)

### 33. UI React completa
Board com drag-and-drop (dnd-kit), colunas por status, filtros por tag, ordenação configurável, drawer de log, visualização de diff, notificações do sistema e sons. Os projetos do rail lateral também se arrastam (mouse ou teclado: foco + espaço + setas) para definir a ordem, persistida em `projects.json` via `POST /api/projects/reorder`. (`web/src/`)

### 34. Webhook de mudança de status, falha e ação humana
Com `webhookUrl` configurado no projeto, o servidor faz `POST` de JSON (`{ event, projectId, project, taskId, taskTitle, at, … }`) nos casos em que ninguém pode ficar esperando o board aberto: `task_status_changed` (task mudou de status pela UI, pela API ou por move manual de arquivo — com `from` e `to`, incluindo `to: "archived"`), `run_failed` (exit code ≠ 0, timeout ou verificação reprovada), `human_request` (o agente deixou uma `## Human Request`), `pending_action` (guardrail bloqueou um comando), `pr_needs_human` (o acompanhamento de PR desistiu), `goal_needs_human` (o loop de lacunas parou sem cumprir a spec; `reason` lista o que falta), `task_needs_human` (o diagnóstico automático apontou causa externa; `reason` traz causa e evidência) e `daily_digest` (resumo diário, se ligado). O `webhookStatuses` do projeto — checkboxes "Status avisados" nas Configurações do projeto — restringe quais status disparam `task_status_changed` (nenhum marcado = todos); os outros eventos passam sempre. Fire-and-forget com timeout de 10s: endpoint fora do ar não trava nem derruba o run. (`server/src/lib/webhook.js`)

### 35. Configurações globais em abas e tema claro/escuro
As configurações globais são separadas por tema em abas — **Execução** (concorrência, catálogo de modelos), **Aparência**, **Alertas** (notificações e sons) e **Extensões**. Em Aparência dá para escolher tema **Sistema** (default, acompanha o modo claro/escuro do SO em tempo real via `matchMedia`), **Claro** ou **Escuro**; a preferência vive no `localStorage` do navegador, como notificações e sons. O tema escuro só reatribui os design tokens em `:root[data-theme="dark"]` — nenhum componente tem variante `dark:`. (`web/src/theme.js`, `web/src/index.css`, `GlobalSettingsModal` em `web/src/App.jsx`)

### 36. Interface multi-idioma (pt-BR / inglês)
Toda a UI passa por `t()` (`web/src/i18n.js`), que resolve o texto num arquivo por língua em `web/src/languages/<lang>.json` — hoje `pt-BR.json` e `en.json`. A chave é o próprio texto em português: `pt-BR.json` é a identidade (serve de template e de lista canônica das strings) e uma chave sem tradução cai no português, então nada some da tela. Placeholders `{var}` cobrem interpolação (`t('Nova task em {col}', { col })`). A escolha fica em **Configurações globais → Aparência → Idioma**, vale para todos os projetos e vive no `localStorage` (`ck.lang`), como tema e sons; trocar recarrega a página, porque boa parte das strings é resolvida na importação dos módulos. O mesmo valor serve de locale para `Intl` (datas e ordenação alfabética) e vai para o atributo `lang` do `<html>`. Para adicionar uma língua: copiar `pt-BR.json`, traduzir os valores e registrar em `LANGUAGES`/`DICTS` no `i18n.js`. (`web/src/i18n.js`, `web/src/languages/`)

### 37. Gerenciador de extensões (skills, agents, commands, hooks e plugins)
Um drawer único para **buscar, instalar, ativar/desativar e remover** as extensões do Claude Code, em dois escopos: **Global** (`~/.claude`, vale para todos os projetos deste computador) e **Projeto** (`<projeto>/.claude`, versionado junto com o repo — abre pelo menu do projeto no board). O que o usuário já tinha instalado por fora aparece na lista junto com o que veio do kanban, e é manuseável do mesmo jeito.

Um **catálogo embutido** (`server/src/lib/catalog.js`) oferece skills, agents e hooks prontos para instalar com um clique; um item já instalado some do catálogo — hook é reconhecido por hash do conteúdo (`signature`), não pelo nome.

**Desativar não apaga.** O Claude Code carrega tudo que estiver nas pastas, sem flag de "desativado": então skill/agent/command desativado é movido para a pasta irmã `<kind>-disabled/`, que o Claude não varre e que deixa o estado visível no disco. Hook é entrada de JSON em `settings.json` — desativar tira a entrada de lá e guarda a definição original em `~/.claude-kanban/disabled-hooks.json`, para não perder o que o usuário escreveu.

**Plugins são delegados ao CLI** (`claude plugin list/install/uninstall/enable/disable`), que já sabe resolver marketplaces, cache e escopo — sem projeto vai `--scope user`, com projeto `--scope project` rodando com `cwd` no projeto. A listagem de marketplace é cacheada 60s e a UI mostra os primeiros 40 resultados, avisando quantos ficaram de fora. Sem o CLI `claude` no PATH, as rotas de plugin respondem **503**. (`server/src/lib/extensions.js`, `server/src/lib/catalog.js`, `server/src/lib/pluginsCli.js`, `server/src/routes/extensions.js`, `web/src/Extensions.jsx`)

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
- **Auto-pilot completo**: auto-run, auto-decompose com branch de integração, replanejamento, revisão automática, teto de custo por objetivo, enrich, retry com backoff e escalação de modelo, agendamento, gate de verificação com referência na base, resolução de conflito, auto-merge por política, acompanhamento de PR e entrada automática de trabalho.
