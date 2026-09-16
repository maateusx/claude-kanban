# 0001 — Fila de merge serializada e revert automático

Data: 2026-09-16 · Task: 5ov2fj

## Contexto

Com subtasks em paralelo e auto-merge, branches que passam sozinhas podem
quebrar juntas. O merge na base (auto-merge local) e a integração no pai
aconteciam direto no `finish()`, sem verificar o resultado combinado. Um merge
do autopilot que quebrava o CI da base só virava uma task de CI nova.

## Decisão

- **Uma fila de merge no runner** (`Runner.mergeQueue`, persistida em
  `state.json`), para a base e para `kanban/<pai>`. Um item por vez em todos os
  projetos (serialização global, que já garante "um por destino").
- Cada item: `merge-tree` com a ponta atual do destino → `verifyCommand`
  assíncrono num worktree destacado em cima do commit de merge → grava. Sem
  verify quando o resultado é fast-forward (a árvore é a que o gate da task já
  testou). Falha que o destino já tinha não conta (verify de referência).
- Destino que andou durante o verify ⇒ o item volta para o fim da fila.
- Conflito ou verify reprovado ⇒ a resolução de conflito existente
  (`scheduleConflictFix`, tag `conflito`, `merge_from` = destino). A task sai do
  ledger mesmo quando vai para o humano, para o pai não contá-la como integrada.
- A subtask vira `done` ao concluir e só ganha `integrada` quando entra; o pai
  espera enquanto ela estiver na fila (`pendingDeps`).
- **PRs**: o "verify" é o CI do GitHub. Uma PR mergeada por rodada; PR atrás
  de `origin/<base>` recebe `gh pr update-branch` e só mergeia quando o CI
  passa de novo.
- **Revert**: o sha de cada merge do autopilot fica em `run.merge_sha`. Com
  `watchMainCI`, run falhado exatamente nesse sha ⇒ revert na branch
  `kanban/revert-<id>`. Merge local ⇒ o servidor mergeia o revert na base (mesmo
  caminho que fez o merge; os guardrails valem para a sessão, não para o
  servidor). PR ⇒ push da branch + PR de revert, que um humano mergeia.
  A task reabre com a tag `revertido` e instruções para trazer o trabalho de
  volta (merge da base + revert do revert). Uma vez por task.

## Alternativas

- Fila por destino em paralelo: mais vazão, mais estado. Adiar até a fila
  global virar gargalo.
- Verify síncrono (`spawnSync`) como o gate da task: mais simples, mas a UI não
  veria a fila andando e o servidor ficaria travado por minutos.
- Branch de staging no GitHub (bors real): exige configuração do repositório.
- Revert direto na base em todos os casos: contraria o fluxo via PR quando o
  merge veio de PR.

## Consequências

- Integração no pai e auto-merge ficam assíncronos: testes precisam de
  `await runner.mergeDrain` quando mais de um item entra de uma vez.
- Com PR, o revert espera um humano. Se a task corrigida concluir antes, a
  instrução do feedback cobre os dois casos (revert na base ou não).
- A PR antiga (já mergeada) continua associada à branch; o `capturePR` do run
  seguinte pode encontrá-la em vez de uma PR nova.
