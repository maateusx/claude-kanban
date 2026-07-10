# claude-kanban

Gerenciador de tasks local (React + Node) para o Claude Code. O kanban é uma camada visual sobre arquivos `.md` em `.claude/claude-kanban/tasks/` de cada projeto; as tasks são executadas em sessões headless (`claude -p`), uma por vez, com log ao vivo no board.

Spec completa: [`docs/initial-scope.spec`](docs/initial-scope.spec).

## Requisitos

- Node 20+
- CLI `claude` no PATH (para executar tasks)

## Rodando

```bash
npm install
npm run dev        # backend em :4400 + frontend em :5544 (proxy /api)
```

Abra http://localhost:5544, cadastre um projeto (nome + diretório raiz) — isso dispara o **bootstrap**: estrutura de pastas, `guard.mjs`, skill `claude-kanban` e merge dos hooks em `.claude/settings.json` (idempotente, preserva conteúdo existente).

## Testes

```bash
npm test           # suíte do guard.mjs + core (tasks, bootstrap, pending)
```

## Como funciona

- **Fonte da verdade é o filesystem.** Status vive na pasta (`backlog/ todo/ doing/ done/ archived/`) e no frontmatter; em divergência, **a pasta vence** (reconciliação no boot e via watcher).
- **Sugestão de tasks por análise.** O botão "✨ Sugerir tasks" roda uma sessão headless somente leitura (`Read`/`Glob`/`Grep`) no projeto e sugere tasks dos tipos escolhidos (melhoria, correção, feature, refatoração, teste, documentação). Você seleciona quais viram cards no Backlog — criadas com a tag `sugerida` + o tipo, para filtrar.
- **Fila global de execução**, concorrência 1. Cada task roda em sessão nova e isolada, `--permission-mode acceptEdits` por padrão, ou `--dangerously-skip-permissions` se o toggle por projeto estiver ligado.
- **Guardrails determinísticos** (hooks `PreToolUse` com `deny`, valem mesmo sob skip-permissions):
  - não ler/escrever `.env` (exceto `.example`/`.template`);
  - não commitar/pushar/mergear em `main`/`master`;
  - não deletar branches;
  - não deletar arquivos fora do projeto — ações bloqueadas viram itens em "Ações manuais" (`pending-actions.md`) para o humano.

### Limite honesto dos guardrails

O `guard.mjs` funciona por parsing/regex do comando — **não é sandbox**. Comandos ofuscados (variáveis, base64, scripts intermediários) podem escapar. Os guardrails cobrem o caso realista de o modelo tentar a ação diretamente; para isolamento forte, rode o projeto em container/worktree.

## Estrutura

```
server/   Fastify + watcher (chokidar) + runner (spawn claude -p) + templates (guard.mjs, SKILL.md)
web/      React + Vite + Tailwind + dnd-kit
```

Estado do app: `~/.claude-kanban/` (`projects.json`, `state.json`, `lock`). Sem banco de dados — tudo é arquivo.
