// Ciclo autônomo: subtasks partem da branch do pai e voltam para ela, o pai
// espera as filhas e roda como integração, revisão reprova, replanejamento,
// teto de custo por objetivo e aprendizados entre tasks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-home-'))
const { createTask, findTask, updateTask, replaceSection } = await import('../src/lib/tasks.js')
const { prepareWorkspace, cleanupWorkspace, mergeIntoBranch, taskBranch } = await import('../src/lib/git.js')
const {
  Runner, DECOMPOSED_TAG, REPLANNED_TAG, INTEGRATED_TAG, treeCost, rootIdOf, notesFile, buildPrompt,
} = await import('../src/lib/runner.js')
const { wasSucceeded } = await import('../src/lib/ledger.js')
const { parseReview } = await import('../src/lib/reviewer.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c)
const commit = (dir, msg) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-m', msg) }

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  sh(root, 'init', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  write(root, 'a.txt', 'a\n')
  commit(root, 'init')
  return root
}

function runnerFor(project) {
  const emitted = []
  const runner = new Runner(id => (id === project.id ? project : null), (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {}
  runner.queue = []
  return { runner, emitted }
}

const active = (project, taskId, extra = {}) => ({
  projectId: project.id, taskId, workspace: { cwd: project.path }, taskRelPath: 'x.md',
  result: {}, stderr: '', logEvents: [], logBytes: 0, logStream: null, ...extra,
})

test('subtasks partem da branch do pai e a 2ª enxerga o código da 1ª', () => {
  const root = repo()
  const project = { id: 'pg1', path: root }

  const ws1 = prepareWorkspace(project, 'c1', { parentId: 'pai1' })
  assert.equal(sh(root, 'rev-parse', taskBranch('pai1')), sh(root, 'rev-parse', 'main'), 'pai nasce da base')
  write(ws1.cwd, 'b.txt', 'b\n')
  commit(ws1.cwd, 'filha 1')
  cleanupWorkspace(project, ws1, 'nada.md')
  mergeIntoBranch(root, 'kanban/c1', 'kanban/pai1')

  const ws2 = prepareWorkspace(project, 'c2', { parentId: 'pai1' })
  assert.ok(fs.existsSync(path.join(ws2.cwd, 'b.txt')), 'código da irmã está lá')
  cleanupWorkspace(project, ws2, 'nada.md')
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'checkout principal intocado')
})

test('mergeIntoBranch: merge real sem checkout e conflito sem escrever nada', () => {
  const root = repo()
  sh(root, 'branch', 'alvo')
  sh(root, 'checkout', '-q', '-b', 'x')
  write(root, 'x.txt', 'x\n'); commit(root, 'x')
  sh(root, 'checkout', '-q', 'alvo')
  write(root, 'y.txt', 'y\n'); commit(root, 'y')
  sh(root, 'checkout', '-q', 'main')

  const r = mergeIntoBranch(root, 'x', 'alvo')
  assert.ok(r.merged)
  assert.equal(sh(root, 'show', 'alvo:x.txt'), 'x')
  assert.equal(sh(root, 'show', 'alvo:y.txt'), 'y')
  assert.equal(sh(root, 'rev-list', '--parents', '-n1', 'alvo').split(' ').length, 3, 'commit de merge')

  sh(root, 'checkout', '-q', '-b', 'c1', 'main'); write(root, 'a.txt', 'um\n'); commit(root, 'c1')
  sh(root, 'checkout', '-q', '-b', 'c2', 'main'); write(root, 'a.txt', 'dois\n'); commit(root, 'c2')
  sh(root, 'checkout', '-q', 'main')
  const before = sh(root, 'rev-parse', 'c1')
  assert.throws(() => mergeIntoBranch(root, 'c2', 'c1'), e => e.conflict)
  assert.equal(sh(root, 'rev-parse', 'c1'), before)
})

test('decomposição: pai volta para todo esperando as filhas, fora do ledger', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  const project = { id: 'pd1', path: root }
  const { runner } = runnerFor(project)
  const parent = createTask(root, { title: 'Grande', status: 'doing' })
  const a = { projectId: project.id, taskId: parent.id }
  runner.actives.set(parent.id, a)
  runner.finishDecompose(a, {
    decompose: true, costUsd: 0.5,
    subtasks: [{ title: 'um', description: '', priority: 'medium' }, { title: 'dois', description: '', priority: 'medium' }],
  })

  const p = findTask(root, parent.id)
  assert.equal(p.status, 'todo')
  assert.ok(p.tags.includes(DECOMPOSED_TAG))
  assert.equal(p.decompose, false)
  assert.equal(p.depends_on.length, 3, 'nível 0 ganha a subtask de desenho na frente')
  assert.equal(p.run.total_cost_usd, 0.5)
  assert.ok(!wasSucceeded(parent.id))
  assert.deepEqual(runner.pendingDeps(project, parent.id), p.depends_on, 'gate segura o pai')

  // Todas concluídas: o gate libera o pai.
  for (const id of p.depends_on) updateTask(root, id, { status: 'done' })
  assert.deepEqual(runner.pendingDeps(project, parent.id), [])
})

test('subtask concluída entra na branch do pai; aprendizados vão para notes.md', () => {
  const root = repo()
  const project = { id: 'pi1', path: root }
  const parent = createTask(root, { title: 'Pai', status: 'todo', tags: [DECOMPOSED_TAG] })
  const child = createTask(root, { title: 'Filha', status: 'doing', tags: ['subtask', `pai:${parent.id}`] })
  updateTask(root, child.id, { body: replaceSection(child.body, 'Aprendizados', '- rode `npm test` na raiz') })

  const ws = prepareWorkspace(project, child.id, { parentId: parent.id })
  write(ws.cwd, 'novo.txt', 'n\n'); commit(ws.cwd, 'filha')
  cleanupWorkspace(project, ws, 'nada.md')

  const { runner } = runnerFor(project)
  const a = active(project, child.id, { workspace: ws })
  runner.actives.set(child.id, a)
  runner.finish(a, 0)

  const c = findTask(root, child.id)
  assert.equal(c.status, 'done')
  assert.ok(c.tags.includes(INTEGRATED_TAG))
  assert.equal(sh(root, 'show', `${taskBranch(parent.id)}:novo.txt`), 'n')
  assert.match(fs.readFileSync(notesFile(root), 'utf8'), /Filha[\s\S]*npm test/)
})

test('objetivo integrado fica marcado para a auditoria de lacunas; subtask não', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  const project = { id: 'pg2', path: root }
  const goal = createTask(root, { title: 'Obj', status: 'doing', tags: [DECOMPOSED_TAG] })
  const sub = createTask(root, { title: 'Sub', status: 'doing', tags: [DECOMPOSED_TAG, `pai:${goal.id}`] })
  const { runner } = runnerFor(project)
  for (const t of [goal, sub]) {
    const a = active(project, t.id, { verify: null, workspace: { cwd: root, branch: null } })
    runner.actives.set(t.id, a)
    runner.finish(a, 0)
  }
  assert.equal(findTask(root, goal.id).run.gap_pending, true)
  assert.equal(findTask(root, sub.id).run.gap_pending, undefined)
})

test('buildPrompt injeta o contexto e subtask não faz push', () => {
  const g = { autoPush: true, autoPR: true, baseBranch: 'main', integratesInto: 'kanban/pai' }
  const prompt = buildPrompt('t.md', 'md', 'kanban/c', g, 'off', null, false, '<notas-do-projeto>x</notas-do-projeto>')
  assert.match(prompt, /notas-do-projeto/)
  assert.match(prompt, /NÃO faça push nem abra PR/)
  assert.doesNotMatch(prompt, /gh pr create/)
  assert.match(prompt, /## Aprendizados/)
})

test('revisão reprovada volta para todo como verify reprovado', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  const project = { id: 'pr1', path: root }
  const t = createTask(root, { title: 'Rev', status: 'doing' })
  const { runner, emitted } = runnerFor(project)
  const a = active(project, t.id, { verify: null, review: { approved: false, feedback: 'faltou o endpoint', costUsd: 0.1 } })
  runner.actives.set(t.id, a)
  runner.finish(a, 0)

  const task = findTask(root, t.id)
  assert.equal(task.status, 'todo')
  assert.equal(task.run.exit_reason, 'review_rejected')
  assert.match(task.body, /Revisão automática reprovou[\s\S]*faltou o endpoint/)
  assert.ok(emitted.some(e => e.type === 'run.finished' && e.verifyFailed))
  assert.deepEqual(parseReview('```{"approved":true,"feedback":""}```'), { approved: true, feedback: '' })
})

test('tentativas esgotadas: replaneja uma vez com autoDecompose, depois bloqueia', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  const project = { id: 'pp1', path: root, autoDecompose: true, retry: { maxAttempts: 1, backoffMinutes: 0 } }
  const t = createTask(root, { title: 'Trava', status: 'doing' })
  updateTask(root, t.id, { run: { attempts: 1 } })

  const fail = () => {
    const { runner } = runnerFor(project)
    const a = active(project, t.id)
    runner.actives.set(t.id, a)
    runner.finish(a, 1)
    return findTask(root, t.id)
  }
  let task = fail()
  assert.equal(task.decompose, true)
  assert.ok(task.tags.includes(REPLANNED_TAG))
  assert.ok(!task.tags.includes('blocked'))

  updateTask(root, t.id, { status: 'doing', decompose: null })
  task = fail()
  assert.ok(task.tags.includes('blocked'), 'segunda vez não replaneja')
})

test('teto de custo por objetivo bloqueia a árvore', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-auto-'))
  const project = { id: 'pb1', path: root, goalBudgetUsd: 1 }
  const pai = createTask(root, { title: 'Pai', status: 'todo', tags: [DECOMPOSED_TAG] })
  updateTask(root, pai.id, { run: { total_cost_usd: 0.7 } })
  const f = createTask(root, { title: 'F', status: 'todo', tags: [`pai:${pai.id}`] })
  const neta = createTask(root, { title: 'N', status: 'todo', tags: [`pai:${f.id}`] })
  updateTask(root, f.id, { run: { cost_usd: 0.4 } })

  const all = [findTask(root, pai.id), findTask(root, f.id), findTask(root, neta.id)]
  assert.equal(rootIdOf(all, all[2]), pai.id)
  assert.ok(Math.abs(treeCost(all, pai.id) - 1.1) < 1e-9)

  const { runner, emitted } = runnerFor(project)
  runner.start(project.id, neta.id)
  const n = findTask(root, neta.id)
  assert.ok(n.tags.includes('blocked'))
  assert.equal(n.status, 'todo', 'não chegou a rodar')
  assert.ok(emitted.some(e => e.type === 'run.finished' && e.exitReason === 'goal_budget'))
})
