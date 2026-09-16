// Manutenção periódica (autopilot.maintenance): agendamento por tipo, teto de
// tasks abertas, tag manutencao:<tipo>, dedupe e validação.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-mt-home-'))

// claude falso: grava o prompt e responde com as sugestões de FAKE_DIR/answer.json.
const FAKE = fs.mkdtempSync(path.join(tmpdir(), 'ck-mt-fake-'))
process.env.FAKE_DIR = FAKE
fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = process.env.FAKE_DIR
const a = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'prompts.log'), a[a.indexOf('-p') + 1] + '\\n---\\n')
process.stdout.write(JSON.stringify({ result: fs.readFileSync(path.join(dir, 'answer.json'), 'utf8'), is_error: false }))
`, { mode: 0o755 })
process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`

const { createTask, listTasks } = await import('../src/lib/tasks.js')
const { Autopilot, MAINTENANCE_TAG, MAINTENANCE_TYPES, autopilotSettings } = await import('../src/lib/autopilot.js')
const { applyAutopilot } = await import('../src/routes/projects.js')

const answer = titles => fs.writeFileSync(path.join(FAKE, 'answer.json'), JSON.stringify({
  suggestions: titles.map(title => ({ title, description: 'd', type: 'teste', priority: 'low' })),
}))
const prompts = () => { try { return fs.readFileSync(path.join(FAKE, 'prompts.log'), 'utf8') } catch { return '' } }

function setup(maintenance) {
  fs.rmSync(path.join(FAKE, 'prompts.log'), { force: true })
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-mt-'))
  const project = { id: `mt${Math.random().toString(36).slice(2, 7)}`, name: 'M', path: root, autopilot: { maintenance } }
  const ap = new Autopilot({ db: { projects: [project] }, saveProjects: () => {}, runner: {}, emit: () => {} })
  return { project, root, ap }
}

const mine = (root, kind) => listTasks(root).filter(t => t.tags.includes(`${MAINTENANCE_TAG}:${kind}`))

test('desligado por padrão: nenhum tipo roda', async () => {
  const { project, ap } = setup(undefined)
  for (const m of Object.values(autopilotSettings(project).maintenance)) assert.deepEqual(m, { hours: 0, max: 2 })
  await ap.tick()
  assert.equal(prompts(), '')
})

test('tipo agendado abre tasks com a tag, até o teto, e respeita o intervalo', async () => {
  const { project, root, ap } = setup({ cobertura: { hours: 6, max: 2 } })
  answer(['Testar A', 'Testar B', 'Testar C'])
  const now = Date.now()
  await ap.tick(now)
  const created = mine(root, 'cobertura')
  assert.deepEqual(created.map(t => t.title).sort(), ['Testar A', 'Testar B'])
  assert.deepEqual(created[0].tags, ['teste', MAINTENANCE_TAG, `${MAINTENANCE_TAG}:cobertura`])
  assert.match(prompts(), /sem teste/, 'usa a question do tipo')
  assert.match(prompts(), /"teste"/)
  assert.doesNotMatch(prompts(), /"feature"/, 'restrito ao tipo de sugestão')
  assert.ok(project.autopilotState['maintenance:cobertura'])

  // Antes do intervalo: não roda.
  fs.rmSync(path.join(FAKE, 'prompts.log'))
  await ap.tick(now + 5 * 3600_000)
  assert.equal(prompts(), '')

  // Venceu, mas o teto está cheio: nem chama o modelo.
  await ap.tick(now + 7 * 3600_000)
  assert.equal(prompts(), '')
  assert.equal(mine(root, 'cobertura').length, 2)
})

test('teto conta só tasks abertas do tipo; dedupe por título', async () => {
  const { root, ap } = setup({ lint: { hours: 1, max: 2 } })
  createTask(root, { title: 'Remover x', status: 'done', tags: [`${MAINTENANCE_TAG}:lint`] })
  createTask(root, { title: 'Aberta de outro tipo', status: 'todo', tags: [`${MAINTENANCE_TAG}:docs`] })
  answer(['remover X', 'Limpar y', 'Limpar y', 'Limpar z'])
  await ap.tick()
  assert.deepEqual(mine(root, 'lint').filter(t => t.status !== 'done').map(t => t.title).sort(), ['Limpar y', 'Limpar z'])
  assert.equal(listTasks(root).filter(t => t.tags.includes('refatoracao')).length, 2)
})

test('tipos independentes rodam no mesmo tick', async () => {
  const { root, ap } = setup({ docs: { hours: 24, max: 1 }, dependencias: { hours: 24, max: 1 } })
  answer(['Única'])
  await ap.tick()
  // Mesmo título nos dois: só um cria (dedupe global por título).
  assert.equal(mine(root, 'docs').length + mine(root, 'dependencias').length, 1)
  assert.match(prompts(), /README\.md/)
  assert.match(prompts(), /dependências declaradas/)
})

test('applyAutopilot valida e mescla maintenance por tipo', () => {
  const p = {}
  assert.equal(applyAutopilot(p, { maintenance: { cobertura: { hours: 12 } } }), null)
  assert.equal(applyAutopilot(p, { maintenance: { cobertura: { max: 3 }, docs: { hours: 0 } } }), null)
  assert.deepEqual(p.autopilot.maintenance, { cobertura: { hours: 12, max: 3 }, docs: { hours: 0 } })
  assert.deepEqual(autopilotSettings(p).maintenance.docs, { hours: 0, max: 2 })
  assert.match(applyAutopilot(p, { maintenance: { estilo: { hours: 1 } } }), /tipo desconhecido/)
  assert.match(applyAutopilot(p, { maintenance: { lint: { max: 0 } } }), /lint\.max/)
  assert.match(applyAutopilot(p, { maintenance: { lint: { hours: 1.5 } } }), /lint\.hours/)
  assert.match(applyAutopilot(p, { maintenance: [] }), /objeto/)
  assert.deepEqual(Object.keys(MAINTENANCE_TYPES), ['cobertura', 'lint', 'dependencias', 'docs'])
})
