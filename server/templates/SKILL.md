---
name: claude-kanban
description: Workflow de tasks do claude-kanban — como trabalhar com tasks .md deste projeto, preencher resultados e respeitar as políticas de guardrails.
---

# claude-kanban — workflow de tasks

Este projeto é gerenciado pelo claude-kanban. As tasks vivem em `.claude/claude-kanban/tasks/`, uma por arquivo `.md`, organizadas por pasta de status: `backlog/`, `todo/`, `doing/`, `done/`, `archived/`.

## Schema da task

Frontmatter YAML: `id` (imutável), `title`, `status`, `priority` (low|medium|high|urgent), `tags`, `created_at`, `updated_at` e o bloco `run` (metadados de execução do orquestrador). Corpo: seções `## Descrição`, `## Resultado`, `## Log de erros`.

## Regras obrigatórias

1. **NUNCA altere o frontmatter** de uma task e **NUNCA mova arquivos de task entre pastas** — isso é papel exclusivo do orquestrador (o app claude-kanban).
2. Ao concluir trabalho relacionado a uma task, preencha a seção `## Resultado` com:
   - resumo do que foi feito;
   - decisões técnicas e porquês;
   - arquivos criados/alterados;
   - contexto útil para memória futura;
   - pendências que exigem ação humana, citando os ids (`pa-xxxxxx`) de `.claude/claude-kanban/pending-actions.md`.
3. Para criar uma task nova quando o humano pedir "adiciona isso no backlog": crie um `.md` em `.claude/claude-kanban/tasks/backlog/` com um título descritivo no nome do arquivo e uma seção `## Descrição`. **Não invente frontmatter `id`** — o watcher do app adota o arquivo e completa o frontmatter.

## Políticas do projeto (aplicadas por hooks determinísticos — nem tente)

- **Não ler nem escrever `.env`** (qualquer variante exceto `.env.example`/`.env.template`). Use variáveis já carregadas no ambiente ou peça o valor ao humano.
- **Não commitar, mergear ou pushar em `main`/`master`.** Trabalhe sempre em branch.
- **Não deletar branches** (local ou remoto). Isso é ação exclusivamente humana.
- **Não deletar arquivos fora do diretório do projeto.**

Se uma ação sua for bloqueada pelos guardrails, não tente contornar: a solicitação já foi registrada em `pending-actions.md` para o humano. Relate no `## Resultado` e siga com o restante da task.
