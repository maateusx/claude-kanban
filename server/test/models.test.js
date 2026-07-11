import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MODELS, MODEL_IDS, normalizeModel } from '../src/lib/models.js'
import { createTask, loadTask, findTask } from '../src/lib/tasks.js'
import { tasksDir } from '../src/lib/paths.js'

const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-models-'))

test('todo modelo do catálogo usa o slug exato do modelo', () => {
  for (const m of MODELS) {
    assert.match(m.id, /^claude-/, `${m.id} deve ser o slug oficial, não um apelido`)
  }
  assert.ok(MODEL_IDS.includes('claude-fable-5'))
})

test('normalizeModel aceita slug, migra apelido e descarta desconhecido', () => {
  assert.equal(normalizeModel('claude-opus-4-8'), 'claude-opus-4-8')
  assert.equal(normalizeModel('opus'), 'claude-opus-4-8')
  assert.equal(normalizeModel('fable'), 'claude-fable-5')
  assert.equal(normalizeModel('  sonnet '), 'claude-sonnet-5')
  assert.equal(normalizeModel('gpt-4'), null)
  assert.equal(normalizeModel(''), null)
  assert.equal(normalizeModel(null), null)
  assert.equal(normalizeModel(undefined), null)
})

test('createTask grava o slug oficial mesmo recebendo apelido', () => {
  const root = proj()
  const t = createTask(root, { title: 'com apelido', model: 'haiku' })
  assert.equal(t.model, 'claude-haiku-4-5-20251001')
})

test('loadTask migra frontmatter legado com apelido para o slug oficial', () => {
  const root = proj()
  const dir = tasksDir(root, 'todo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'legada--abc123.md'),
    '---\nid: abc123\ntitle: legada\nstatus: todo\npriority: medium\nmodel: opus\n---\n\n## Descrição\n')

  const t = findTask(root, 'abc123')
  assert.equal(t.model, 'claude-opus-4-8')

  // persistiu no arquivo: reler não depende da migração em memória
  assert.equal(loadTask(root, t.filePath).model, 'claude-opus-4-8')
})
