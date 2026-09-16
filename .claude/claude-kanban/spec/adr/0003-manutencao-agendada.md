# 0003 — Manutenção agendada pelo analyzer somente leitura

Data: 2026-09-16 · Task: tvfvxx

## Contexto

A dívida técnica acumula com o sistema crescendo. O autopilot já abre tasks
sozinho pelo ✨ Suggest agendado (`suggestHours`/`suggestMax`). Faltava um
fluxo dirigido por tipo de manutenção, com cadência e teto próprios.

## Decisão

- `autopilot.maintenance.<tipo> = { hours, max }` para os tipos fixos
  `cobertura`, `lint`, `dependencias`, `docs`. `hours: 0` (default) desliga;
  `max` (default 2) é o teto de tasks abertas (`backlog`/`todo`/`doing`) com a
  tag `manutencao:<tipo>`. Cada tipo é um job independente do tick
  (`autopilotState["maintenance:<tipo>"]`).
- Reusa `analyzeProject` (sessão `Read Glob Grep` no `auxModel`) com uma
  `question` fixa por tipo e **um** tipo de sugestão (`teste`, `refatoracao`,
  `melhoria`, `documentacao`). Nada de sessão com Bash: `dependencias` só lê
  manifestos e lockfiles.
- Tags da task: `<tipo de sugestão>`, `manutencao`, `manutencao:<tipo>`.
  Dedupe por título (case-insensitive) contra todas as tasks do projeto,
  relido depois da análise. Sem vaga no teto, o modelo não é chamado.
- `docs` pede um `README.md` por módulo; não há injeção especial no prompt —
  as sessões leem os READMEs como leem o resto do código.
- O ✨ Suggest agendado passou a usar o mesmo caminho (`fromAnalysis`).

## Alternativas

- Rodar `npm outdated`/linter/cobertura de verdade: dá dado exato, mas exige
  sessão com Bash (ou comandos por ecossistema no servidor). Fica para quando
  o palpite do modelo se mostrar ruim.
- Tipos livres configurados pelo usuário: mais flexível, mas sem a `question`
  pronta cada um vira um Suggest com outro nome.
- Injetar os READMEs de módulo no prompt das tasks: custo de contexto sem
  evidência de ganho.

## Consequências

- Tipo novo = entrada em `MAINTENANCE_TYPES` (`server/src/lib/autopilot.js`),
  que a validação (`applyAutopilot`) e o default já leem; a UI lista os tipos
  à mão em `web/src/App.jsx`.
- Tasks de manutenção concluídas liberam vaga: o teto limita fila, não volume
  total.
