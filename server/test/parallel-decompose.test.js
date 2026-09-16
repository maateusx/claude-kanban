// Decomposição em grafo: subtask de contratos primeiro, irmãs em paralelo,
// fallback em série quando o modelo devolve algo inválido e integrações
// concorrentes na branch do pai.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-par-home-'))
const { createTask, findTask, listTasks, updateTask } = await import('../src/lib/tasks.js')
const { prepareWorkspace, cleanupWorkspace, taskBranch } = await import('../src/lib/git.js')
const { Runner, DECOMPOSED_TAG, INTEGRATED_TAG } = await import('../src/lib/runner.js')
const { parseDecomposition, dependencyGraph } = await import('../src/lib/decomposer.js')
const { DESIGN_TAG } = await import('../src/lib/spec.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c)
const commit = (dir, msg) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-m', msg) }
const answer = subtasks => JSON.stringify({ decompose: true, subtasks })
const sub = (title, depends_on) => ({ title, description: '', ...(depends_on === undefined ? {} : { depends_on }) })

function runnerFor(project) {
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  runner.tick = () => {}
  runner.queue = []
  runner.mergeQueue = []
  return runner
}

test('grafo com contratos primeiro e irmãs paralelas', () => {
  const res = parseDecomposition(answer([sub('contratos', []), sub('api', [1]), sub('ui', [1]), sub('e2e', [2, 3])]))
  assert.equal(res.parallel, true)
  assert.deepEqual(res.subtasks.map(s => [s.title, s.deps]), [
    ['contratos', []], ['api', [0]], ['ui', [0]], ['e2e', [1, 2]],
  ])
  // Dependência para frente: reordena para toda dependência vir antes.
  const fwd = parseDecomposition(answer([sub('ui', [2]), sub('contratos', [])]))
  assert.deepEqual(fwd.subtasks.map(s => [s.title, s.deps]), [['contratos', []], ['ui', [0]]])
})

test('grafo inválido ou ausente cai para série', () => {
  const cases = [
    [sub('a'), sub('b')], // sem depends_on (formato antigo)
    [sub('a', [2]), sub('b', [1])], // ciclo
    [sub('a', []), sub('b', [2])], // a própria
    [sub('a', []), sub('b', [7])], // fora da lista
    [sub('a', []), sub('b', ['1'])], // não é número
    [sub('a', []), sub('b', 1)], // não é lista
    [sub('a', []), { title: '' }, sub('b', [1])], // item descartado desloca as posições
  ]
  for (const list of cases) {
    const res = parseDecomposition(answer(list))
    assert.equal(res.parallel, false, JSON.stringify(list))
    assert.deepEqual(res.subtasks.map(s => s.deps), [[], [0]])
  }
  assert.equal(dependencyGraph([[3], [1], [2]]), null, 'ciclo longo')
  assert.deepEqual(dependencyGraph([null, [1]]).order, [0, 1], 'null = sem dependência')
})

function decompose(root, parentTags, res) {
  const project = { id: `pd-${path.basename(root)}`, path: root }
  const parent = createTask(root, { title: 'Loja', status: 'doing', tags: parentTags })
  const runner = runnerFor(project)
  const a = { projectId: project.id, taskId: parent.id }
  runner.actives.set(parent.id, a)
  runner.finishDecompose(a, { decompose: true, costUsd: 0, ...res })
  const byTitle = Object.fromEntries(listTasks(root).map(t => [t.title, t]))
  return { project, runner, parent: findTask(root, parent.id), byTitle }
}

test('subtasks recebem o grafo e as irmãs liberam juntas depois dos contratos', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-par-'))
  const res = parseDecomposition(answer([sub('contratos', []), sub('api', [1]), sub('ui', [1])]))
  const { project, runner, parent, byTitle: t } = decompose(root, ['nivel:1'], res)
  assert.deepEqual(t.api.depends_on, [t.contratos.id])
  assert.deepEqual(t.ui.depends_on, [t.contratos.id])
  assert.equal(parent.depends_on.length, 3)

  const ready = () => ['api', 'ui'].filter(n => !runner.pendingDeps(project, t[n].id).length)
  assert.deepEqual(ready(), [])
  updateTask(root, t.contratos.id, { status: 'done' })
  assert.deepEqual(ready(), ['api', 'ui'], 'paralelas ao mesmo tempo')
})

test('com desenho, só as raízes esperam por ele; série continua encadeada', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-par-'))
  const res = parseDecomposition(answer([sub('contratos', []), sub('api', [1]), sub('ui', [1])]))
  const { byTitle: t } = decompose(root, [], res)
  const design = Object.values(t).find(x => x.tags.includes(DESIGN_TAG))
  assert.deepEqual(design.depends_on, [])
  assert.deepEqual(t.contratos.depends_on, [design.id])
  assert.deepEqual(t.api.depends_on, [t.contratos.id])

  const root2 = fs.mkdtempSync(path.join(tmpdir(), 'ck-par-'))
  const { byTitle: s } = decompose(root2, ['nivel:1'], { subtasks: [sub('um'), sub('dois'), sub('tres')] })
  assert.deepEqual(s.dois.depends_on, [s.um.id])
  assert.deepEqual(s.tres.depends_on, [s.dois.id])
})

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-par-'))
  sh(root, 'init', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  write(root, 'a.txt', 'a\n')
  commit(root, 'init')
  return root
}

test('irmãs paralelas integram no pai uma de cada vez; conflito vira sessão de resolução', async () => {
  const root = repo()
  const project = { id: 'pm1', path: root }
  const parent = createTask(root, { title: 'Pai', status: 'todo', tags: [DECOMPOSED_TAG] })
  const kids = ['api', 'ui', 'rival'].map(title =>
    createTask(root, { title, status: 'doing', tags: ['subtask', `pai:${parent.id}`] }))

  // As três partem do mesmo ponto do pai, antes de qualquer uma integrar.
  const files = { api: ['api.txt', 'api\n'], ui: ['ui.txt', 'ui\n'], rival: ['api.txt', 'outra\n'] }
  const wss = kids.map(k => {
    const ws = prepareWorkspace(project, k.id, { parentId: parent.id })
    write(ws.cwd, ...files[k.title]); commit(ws.cwd, k.title)
    cleanupWorkspace(project, ws, 'nada.md')
    return ws
  })

  const runner = runnerFor(project)
  const actives = kids.map((k, i) => ({
    projectId: project.id, taskId: k.id, workspace: wss[i], taskRelPath: 'x.md', verify: null,
    result: {}, stderr: '', logEvents: [], logBytes: 0, logStream: null,
  }))
  for (const a of actives) runner.actives.set(a.taskId, a)
  for (const a of actives) runner.finish(a, 0)
  await runner.mergeDrain

  const into = taskBranch(parent.id)
  assert.equal(sh(root, 'show', `${into}:api.txt`), 'api')
  assert.equal(sh(root, 'show', `${into}:ui.txt`), 'ui', 'a 2ª integrou por cima da 1ª')
  for (const k of kids.slice(0, 2)) assert.ok(findTask(root, k.id).tags.includes(INTEGRATED_TAG))

  const rival = findTask(root, kids[2].id)
  assert.equal(rival.status, 'todo')
  assert.equal(rival.run.exit_reason, 'integration_conflict')
  assert.equal(rival.run.merge_from, into, 'resolução mergeia o pai na branch da filha')
  assert.ok(!rival.tags.includes(INTEGRATED_TAG))
  assert.ok(runner.queue.some(q => q.taskId === rival.id), 'reenfileirada para resolver')
})
