// Limpeza de branches kanban/* e worktrees órfãos (autopilot.cleanup).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-cl-home-'))

const { prepareWorkspace, cleanupCandidates, applyCleanup } = await import('../src/lib/git.js')
const { Autopilot, autopilotSettings, buildDigest } = await import('../src/lib/autopilot.js')
const { applyAutopilot } = await import('../src/routes/projects.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-cl-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'init')
  return root
}

// Branch kanban/<id> com um commit próprio (não mergeado) ou sem nenhum (contida na base).
function branch(root, id, { work = false } = {}) {
  sh(root, 'branch', `kanban/${id}`)
  if (!work) return
  sh(root, 'checkout', '-q', `kanban/${id}`)
  fs.writeFileSync(path.join(root, `${id}.txt`), id)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', id)
  sh(root, 'checkout', '-q', 'main')
}

const names = c => c.branches.map(b => b.name).sort()
const branches = root => sh(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/kanban/').split('\n').filter(Boolean).sort()

test('candidatos: mergeada entra, trabalho não mergeado e task ativa nunca', () => {
  const root = repo()
  const project = { id: 'pcl1', path: root }
  branch(root, 'merged1')                    // contida na base, task arquivada
  branch(root, 'gone1')                      // contida na base, task não existe mais
  branch(root, 'work1', { work: true })      // trabalho não mergeado, task arquivada
  branch(root, 'orphan1', { work: true })    // trabalho não mergeado, task sumiu
  branch(root, 'squash1', { work: true })    // PR squash: tag merged
  branch(root, 'disc1', { work: true })      // descartada pelo humano
  branch(root, 'todo1')                      // task em todo — nunca
  branch(root, 'doing1')                     // task em doing — nunca
  branch(root, 'pr1')                        // PR aberta — nunca
  branch(root, 'busy1')                      // na fila do runner — nunca
  const tasks = [
    { id: 'merged1', status: 'archived' },
    { id: 'work1', status: 'archived' },
    { id: 'squash1', status: 'archived', tags: ['merged'] },
    { id: 'disc1', status: 'done', tags: ['discarded'] },
    { id: 'todo1', status: 'todo', tags: ['merged'] },
    { id: 'doing1', status: 'doing' },
    { id: 'pr1', status: 'done', run: { pr: { number: 7, state: 'OPEN' } } },
    { id: 'busy1', status: 'done' },
  ]
  const busy = id => id === 'busy1'
  const c = cleanupCandidates(project, tasks, busy)
  assert.deepEqual(names(c), ['kanban/disc1', 'kanban/gone1', 'kanban/merged1', 'kanban/squash1'])
  assert.equal(c.branches.find(b => b.name === 'kanban/squash1').reason, 'merged')
  assert.equal(c.branches.find(b => b.name === 'kanban/disc1').reason, 'discarded')

  // Branch checada no checkout principal fica, mesmo mergeada.
  sh(root, 'checkout', '-q', 'kanban/merged1')
  assert.ok(!names(cleanupCandidates(project, tasks, busy)).includes('kanban/merged1'))
  sh(root, 'checkout', '-q', 'main')

  // Aprovação em lote: só o que foi pedido e ainda é candidato.
  const res = applyCleanup(project, tasks, { busy, only: { branches: ['kanban/merged1', 'kanban/work1'] } })
  assert.deepEqual(res.branches, ['kanban/merged1'])
  assert.ok(!branches(root).includes('kanban/merged1'))
  assert.ok(branches(root).includes('kanban/work1'))

  const all = applyCleanup(project, tasks, { busy })
  assert.deepEqual(all.branches.sort(), ['kanban/disc1', 'kanban/gone1', 'kanban/squash1'])
  assert.deepEqual(branches(root), ['kanban/busy1', 'kanban/doing1', 'kanban/orphan1', 'kanban/pr1', 'kanban/todo1', 'kanban/work1'])
})

test('worktree órfão: commit de segurança, remoção e a branch sai no mesmo lote', () => {
  const root = repo()
  const project = { id: 'pcl2', path: root }
  const ws = prepareWorkspace(project, 'wt1')
  fs.writeFileSync(path.join(ws.cwd, 'b.txt'), 'b')   // sessão morreu sem commitar
  const live = prepareWorkspace(project, 'wt2')       // sessão viva
  const tasks = [{ id: 'wt1', status: 'done', tags: ['discarded'] }, { id: 'wt2', status: 'doing' }]
  const busy = id => id === 'wt2'

  const c = cleanupCandidates(project, tasks, busy)
  assert.deepEqual(c.worktrees.map(w => [w.taskId, w.reason]), [['wt1', 'idle']])
  assert.deepEqual(names(c), ['kanban/wt1'], 'branch presa em worktree órfão é candidata')

  // Sem a tag discarded, o worktree sai mas a branch (com o auto-commit) fica.
  const res = applyCleanup(project, [{ id: 'wt1', status: 'done' }], { busy })
  assert.equal(res.worktrees.length, 1)
  assert.ok(!fs.existsSync(ws.cwd))
  assert.ok(fs.existsSync(live.cwd))
  assert.deepEqual(res.branches, [])
  assert.match(sh(root, 'log', '-1', '--format=%s', 'kanban/wt1'), /auto-commit de segurança/)
})

test('autopilot: job só roda em modo auto e registra o resultado', async () => {
  const root = repo()
  branch(root, 'm1')
  const saved = []
  const p = { id: 'pcl3', name: 'x', path: root, autopilot: { cleanup: { enabled: true } } }
  const db = { projects: [p] }
  const runner = { actives: new Map(), queue: [] }
  const ap = new Autopilot({ db, saveProjects: () => saved.push(1), runner, emit: () => {}, claudeAvailable: () => false })
  assert.deepEqual(autopilotSettings(p).cleanup, { enabled: true, mode: 'confirm', remote: false })

  await ap.tick()
  assert.deepEqual(branches(root), ['kanban/m1'], 'confirm não remove sozinho')

  p.autopilot.cleanup.mode = 'auto'
  await ap.tick()
  assert.deepEqual(branches(root), [])
  assert.deepEqual(p.autopilotState.cleanupLast.branches, ['kanban/m1'])
  const d = buildDigest([], Date.now(), p.autopilotState.cleanupLast)
  assert.match(d.text, /Branches removidas: kanban\/m1/)
})

test('applyAutopilot valida cleanup', () => {
  const p = {}
  assert.equal(applyAutopilot(p, { cleanup: { enabled: true, mode: 'auto', remote: 1 } }), null)
  assert.deepEqual(p.autopilot.cleanup, { enabled: true, mode: 'auto', remote: true })
  assert.match(applyAutopilot(p, { cleanup: { mode: 'sempre' } }), /confirm ou auto/)
})

test('rotas: GET lista candidatos, POST remove só o lote pedido', async () => {
  const { buildApp } = await import('../src/app.js')
  const root = repo()
  branch(root, 'r1')
  branch(root, 'r2')
  const p = { id: 'pcl4', name: 'x', path: root }
  const runner = { actives: new Map(), queue: [] }
  const devServers = { isRunning: () => false }
  const app = await buildApp({ db: { projects: [p] }, runner, devServers, emit: () => {} })
  const listed = (await app.inject({ method: 'GET', url: '/api/projects/pcl4/cleanup' })).json()
  assert.deepEqual(names(listed), ['kanban/r1', 'kanban/r2'])
  const bad = await app.inject({ method: 'POST', url: '/api/projects/pcl4/cleanup', payload: { branches: 'kanban/r1' } })
  assert.equal(bad.statusCode, 400)
  const res = (await app.inject({ method: 'POST', url: '/api/projects/pcl4/cleanup', payload: { branches: ['kanban/r1'] } })).json()
  assert.deepEqual(res.branches, ['kanban/r1'])
  assert.deepEqual(branches(root), ['kanban/r2'])
  await app.close()
})
