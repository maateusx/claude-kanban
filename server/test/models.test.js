import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FALLBACK_MODELS, listModels, normalizeModel, refreshModels, modelsCatalog, _resetModelsCache } from '../src/lib/models.js'
import { createTask, loadTask, findTask } from '../src/lib/tasks.js'
import { tasksDir, MODELS_FILE } from '../src/lib/paths.js'

const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-models-'))

test('todo modelo do catálogo usa o slug exato do modelo', () => {
  for (const m of FALLBACK_MODELS) {
    assert.match(m.id, /^claude-/, `${m.id} deve ser o slug oficial, não um apelido`)
  }
  assert.ok(listModels().some(m => m.id === 'claude-opus-5'))
})

test('normalizeModel aceita slug, migra apelido e descarta desconhecido', () => {
  assert.equal(normalizeModel('claude-opus-4-8'), 'claude-opus-4-8')
  // apelido resolve para o mais recente da família (catálogo é newest-first)
  assert.equal(normalizeModel('opus'), 'claude-opus-5')
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
  assert.equal(t.model, normalizeModel('haiku'))
  assert.match(t.model, /^claude-haiku-/)
})

test('loadTask migra frontmatter legado com apelido para o slug oficial', () => {
  const root = proj()
  const dir = tasksDir(root, 'todo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'legada--abc123.md'),
    '---\nid: abc123\ntitle: legada\nstatus: todo\npriority: medium\nmodel: opus\n---\n\n## Descrição\n')

  const t = findTask(root, 'abc123')
  assert.equal(t.model, 'claude-opus-5')

  // persistiu no arquivo: reler não depende da migração em memória
  assert.equal(loadTask(root, t.filePath).model, 'claude-opus-5')
})

// --- refresh via Models API ---------------------------------------------
// paths.js resolve CLAUDE_KANBAN_HOME no import, então refreshModels grava no
// HOME de verdade: cada teste devolve o models.json ao estado anterior.

function restoreCatalogFile() {
  let before
  try { before = readFileSync(MODELS_FILE) } catch { before = null }
  return () => {
    if (before === null) rmSync(MODELS_FILE, { force: true })
    else writeFileSync(MODELS_FILE, before)
    _resetModelsCache()
  }
}

test('refreshModels troca o catálogo pelo que a Models API devolveu', async (t) => {
  const realFetch = globalThis.fetch
  const restore = restoreCatalogFile()
  t.after(() => { globalThis.fetch = realFetch; restore() })

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [
      { id: 'claude-omega-9', display_name: 'Claude Omega 9' },
      { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
      { id: 'nao-anthropic', display_name: 'Outro' },
    ] }),
  })

  const out = await refreshModels()
  assert.equal(out.source, 'api')
  assert.ok(out.fetchedAt)
  // ignora ids fora do namespace claude- e tira o prefixo "Claude " do rótulo
  assert.deepEqual(out.models, [
    { id: 'claude-omega-9', label: 'Omega 9' },
    { id: 'claude-opus-5', label: 'Opus 5' },
  ])
  assert.equal(normalizeModel('claude-omega-9'), 'claude-omega-9')
  // modelo do fallback que sumiu da API continua válido: task antiga não vira null
  assert.equal(normalizeModel('claude-sonnet-4-6'), 'claude-sonnet-4-6')
})

test('refreshModels propaga erro da API e mantém o catálogo anterior', async (t) => {
  const realFetch = globalThis.fetch
  const restore = restoreCatalogFile()
  t.after(() => { globalThis.fetch = realFetch; restore() })

  const before = modelsCatalog()
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  await assert.rejects(refreshModels(), /401/)
  assert.deepEqual(modelsCatalog().models, before.models)
})
