import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildEnrichPrompt, parseEnrichment } from '../src/lib/enricher.js'
import { hasHumanRequest } from '../src/lib/runner.js'
import { getSection, replaceSection, createTask, updateTask, findTask } from '../src/lib/tasks.js'

process.env.CLAUDE_KANBAN_HOME ||= mkdtempSync(path.join(tmpdir(), 'ck-home-'))

const BODY = `
## Descrição

fazer algo

## Resultado
<!-- Preenchido pelo Claude ao concluir -->

## Log de erros
`

test('getSection extrai a seção certa e ignora comentários', () => {
  assert.equal(getSection(BODY, 'Descrição'), 'fazer algo')
  assert.equal(getSection(BODY, 'Resultado'), '')
  assert.equal(getSection(BODY, 'Inexistente'), '')
})

test('replaceSection troca só a seção alvo e preserva as demais', () => {
  const out = replaceSection(BODY, 'Descrição', 'novo texto\ncom duas linhas')
  assert.equal(getSection(out, 'Descrição'), 'novo texto\ncom duas linhas')
  assert.ok(out.includes('## Resultado'))
  assert.ok(out.includes('## Log de erros'))
})

test('replaceSection cria a seção quando ela não existe', () => {
  const out = replaceSection('## Descrição\n\nx\n', 'Human Request', 'qual banco usar?')
  assert.equal(getSection(out, 'Human Request'), 'qual banco usar?')
})

test('hasHumanRequest: só com seção preenchida', () => {
  assert.equal(hasHumanRequest(BODY), false)
  assert.equal(hasHumanRequest(BODY + '\n## Human Request\n\n<!-- só comentário -->\n'), false)
  assert.equal(hasHumanRequest(BODY + '\n## Human Request\n\nPostgres ou SQLite?\n'), true)
  assert.equal(hasHumanRequest(null), false)
})

test('buildEnrichPrompt inclui descrição atual e a condição do modo auto', () => {
  const task = { title: 'T', body: BODY }
  const always = buildEnrichPrompt(task)
  assert.ok(always.includes('fazer algo'))
  assert.ok(!always.includes('NÃO reescreva'))
  const auto = buildEnrichPrompt(task, { auto: true })
  assert.ok(auto.includes('NÃO reescreva'))
})

test('parseEnrichment aceita JSON cercado de texto e valida campos', () => {
  const r = parseEnrichment('bla {"enrich":true,"reason":"vaga","title":"Novo","description":"desc"} bla')
  assert.deepEqual(r, { enrich: true, reason: 'vaga', title: 'Novo', description: 'desc' })
  const skip = parseEnrichment('{"enrich":false,"reason":"já clara"}')
  assert.equal(skip.enrich, false)
  assert.throws(() => parseEnrichment('sem json'))
  assert.throws(() => parseEnrichment('{"enrich":true}'), /sem descrição/)
})

test('campo enrich persiste no frontmatter e aceita override', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-enrich-'))
  const t = createTask(root, { title: 'x', enrich: true })
  assert.equal(findTask(root, t.id).enrich, true)
  updateTask(root, t.id, { enrich: false })
  assert.equal(findTask(root, t.id).enrich, false)
  updateTask(root, t.id, { enrich: null })
  assert.equal(findTask(root, t.id).enrich, null)
})
