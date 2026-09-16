// Spec e ADRs como fonte da verdade: subtask de desenho, spec no prompt e
// decisões automáticas registradas como ADR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-home-'))
const { createTask, findTask, listTasks } = await import('../src/lib/tasks.js')
const { Runner, buildPrompt, AUTO_DECIDE_RESPONSE } = await import('../src/lib/runner.js')
const { specBlock, specDir, readSpec, specExcerpt, DESIGN_TAG, SYSTEM_TAG } = await import('../src/lib/spec.js')
const { buildPrompt: buildDecomposePrompt } = await import('../src/lib/decomposer.js')

const SPEC = `# Loja

Sistema de pedidos com API e painel.

## Pagamentos

Módulo que cobra o cartão. Contrato: POST /pagamentos.

## Catálogo

Lista produtos e estoque.
`

function withSpec() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))
  fs.mkdirSync(path.join(specDir(root), 'adr'), { recursive: true })
  fs.writeFileSync(path.join(specDir(root), 'SPEC.md'), SPEC)
  fs.writeFileSync(path.join(specDir(root), 'adr', '0001-gateway.md'), '# Stripe como gateway\n\nDecidido.')
  fs.writeFileSync(path.join(specDir(root), 'adr', 'rascunho.md'), 'não é ADR')
  return root
}

test('readSpec lê SPEC.md e só os ADRs numerados', () => {
  const { spec, adrs } = readSpec(withSpec())
  assert.match(spec, /# Loja/)
  assert.deepEqual(adrs.map(a => [a.file, a.title]), [['0001-gateway.md', 'Stripe como gateway']])
  assert.deepEqual(readSpec(fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))), { spec: '', adrs: [] })
})

test('specExcerpt devolve resumo + a seção que mais combina com a task', () => {
  const ex = specExcerpt(SPEC, 'Estorno de pagamentos no cartão')
  assert.match(ex.intro, /Sistema de pedidos/)
  assert.match(ex.section, /^## Pagamentos/)
  assert.deepEqual(ex.headings, ['Pagamentos', 'Catálogo'])
  assert.equal(specExcerpt(SPEC, 'nada a ver').section, null)
})

test('prompt da subtask injeta a spec com teto de tamanho', () => {
  const root = withSpec()
  const block = specBlock(root, { title: 'Estorno de pagamentos', body: '' })
  const prompt = buildPrompt('t.md', 'md', 'kanban/x', {}, 'off', null, false, block)
  assert.match(prompt, /<spec>[\s\S]*Sistema de pedidos[\s\S]*## Pagamentos[\s\S]*0001-gateway\.md: Stripe como gateway[\s\S]*<\/spec>/)
  assert.doesNotMatch(prompt, /Lista produtos/, 'só a seção relevante vai inteira')

  fs.writeFileSync(path.join(specDir(root), 'SPEC.md'), `# Big\n\n${'x '.repeat(10000)}`)
  assert.ok(specBlock(root, { title: 't' }).length < 7000)
})

test('sem spec: só a task de desenho recebe instrução de criá-la', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))
  assert.equal(specBlock(root, { title: 't', tags: [] }), '')
  assert.match(specBlock(root, { title: 't', tags: [DESIGN_TAG] }), /Crie \.claude\/claude-kanban\/spec\/SPEC\.md/)
})

test('autoDecide decide pela spec e registra ADR', () => {
  const prompt = buildPrompt('t.md', 'md', 'kanban/x', {}, 'off', null, true)
  assert.match(prompt, /spec e pelos ADRs existentes/)
  assert.match(prompt, /novo ADR em \.claude\/claude-kanban\/spec\/adr\/NNNN-titulo\.md/)
  assert.doesNotMatch(buildPrompt('t.md', 'md', 'kanban/x', {}, 'off', null, false), /novo ADR/)
  assert.match(AUTO_DECIDE_RESPONSE, /novo ADR/, 'a resposta automática da retomada também pede o ADR')
})

function decompose(parent) {
  const root = parent.root
  const project = { id: 'ps', path: root }
  const runner = new Runner(() => project, () => {})
  runner.tick = () => {}
  runner.queue = []
  const a = { projectId: project.id, taskId: parent.id }
  runner.actives.set(parent.id, a)
  runner.finishDecompose(a, {
    decompose: true, costUsd: 0,
    subtasks: [{ title: 'api', description: '', priority: 'medium' }, { title: 'ui', description: '', priority: 'medium' }],
  })
  return listTasks(root).filter(t => t.id !== parent.id)
}

test('objetivo de nível 0 ganha subtask de desenho antes das demais', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))
  const parent = { ...createTask(root, { title: 'Loja', status: 'doing' }), root }
  const kids = decompose(parent)
  const design = kids.find(t => t.tags.includes(DESIGN_TAG))
  assert.ok(design, 'subtask de desenho criada')
  assert.equal(design.decompose, false)
  assert.deepEqual(design.depends_on, [])
  const api = kids.find(t => t.title === 'api')
  assert.deepEqual(api.depends_on, [design.id], 'as demais esperam o desenho')
  assert.equal(findTask(root, parent.id).depends_on.length, 3)
})

test('subtask de nível 1 só ganha desenho com a tag sistema', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))
  const plain = { ...createTask(root, { title: 'Parte', status: 'doing', tags: ['nivel:1'] }), root }
  assert.ok(!decompose(plain).some(t => t.tags.includes(DESIGN_TAG)))

  const root2 = fs.mkdtempSync(path.join(tmpdir(), 'ck-spec-'))
  const sys = { ...createTask(root2, { title: 'Parte', status: 'doing', tags: ['nivel:1', SYSTEM_TAG] }), root: root2 }
  assert.ok(decompose(sys).some(t => t.tags.includes(DESIGN_TAG)))
  assert.match(buildDecomposePrompt({ title: 'x', tags: [SYSTEM_TAG, 'nivel:1'] }, 'auto'), /subtask de desenho/)
  assert.doesNotMatch(buildDecomposePrompt({ title: 'x', tags: ['nivel:1'] }, 'auto'), /subtask de desenho/)
})
