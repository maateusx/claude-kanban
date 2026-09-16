# 0002 — Ações de guardrail resolvidas por política do projeto

Data: 2026-09-16 · Task: rmd2mj

## Contexto

Ações bloqueadas pelo `guard.mjs` caem em `pending-actions.md` e sempre
esperam um humano, mesmo as previsíveis (apagar uma branch `kanban/*` já
mergeada). O agente não pode ganhar essas permissões.

## Decisão

- `project.guardrailPolicy`: lista de padrões de comando. `*` casa qualquer
  trecho; o padrão precisa casar o comando **inteiro**. Ausente ⇒ default
  `["git branch -d kanban/*"]`; lista vazia ⇒ tudo vai para o humano.
- O **servidor** executa (reusa `runPendingAction`) a cada `pending.updated`
  do watcher e marca o item como `done`, com a regra, o exit e a saída
  indentada no próprio bloco. Falha de execução também resolve o item (a saída
  mostra o motivo); a política não reabre nem tenta de novo.
- Comando com metacaractere de shell (`;&|<>$` crase, barra invertida, aspas,
  `*?()`, quebra de linha) nunca casa, para que encadear não passe por um
  padrão largo como `npm install *`.
- Proibido mesmo com padrão `*`: tocar `.env` (`bashTouchesEnv` do guard) e as
  regras de git do guard (commit/merge/push em main/master, força) mais push que
  cite o `baseBranch` do projeto. O servidor importa essas funções do
  `server/templates/guard.mjs` para as duas camadas não divergirem.
- Itens cobertos pela política não disparam o webhook `pending_action`.
- `guard.mjs` não muda: o agente continua bloqueado.

## Alternativas

- Liberar os padrões no próprio hook (o agente executaria): descartado, a task
  pede que só o orquestrador execute.
- Regex ou glob completo (minimatch) como padrão: mais poder, mais chance de
  regra larga demais; `*` simples cobre os casos pedidos.
- Remoção remota (`git push origin --delete kanban/*`) no default: o push não
  verifica merge, então ficou de fora.

## Consequências

- Ações que já estavam pendentes e casam com a política rodam na próxima
  mudança do `pending-actions.md` (não no boot).
- Padrão sem `*` só casa aquele comando exato.
- Argumentos com aspas ou globs não são aceitos pela política e vão para o humano.
