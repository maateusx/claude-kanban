// Fila de merge (estilo bors): atualiza com a base → verifyCommand → merge, um
// de cada vez; revert automático quando o CI da base quebra num merge do autopilot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-mq-home-'))

// gh falso: responde a partir de arquivos em FAKE_DIR e registra as chamadas.
const FAKE = fs.mkdtempSync(path.join(tmpdir(), 'ck-mq-fake-'))
process.env.FAKE_DIR = FAKE
fs.writeFileSync(path.join(FAKE, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = process.env.FAKE_DIR
const a = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'gh.log'), a.join(' ') + '\\n')
const out = f => process.stdout.write(fs.readFileSync(path.join(dir, f)))
if (a[0] === 'pr' && a[1] === 'view') out('pr.json')
else if (a[0] === 'run' && a[1] === 'list') out('runs.json')
else if (a[0] === 'run' && a[1] === 'view') process.stdout.write('npm ERR! quebrou na main')
else if (a[0] === 'api') process.stdout.write('[]')
else if (a[0] === 'pr' && ['merge', 'update-branch'].includes(a[1])) process.stdout.write('ok')
else process.exit(1)
`, { mode: 0o755 })
process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`

const { createTask, findTask, updateTask } = await import('../src/lib/tasks.js')
const { prepareWorkspace, taskBranch } = await import('../src/lib/git.js')
const { Runner, CONFLICT_TAG, PR_FEEDBACK } = await import('../src/lib/runner.js')
const { Autopilot, REVERTED_TAG } = await import('../src/lib/autopilot.js')
const { markSucceeded } = await import('../src/lib/ledger.js')
const { diffFile } = await import('../src/lib/paths.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c)
const commit = (dir, msg) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg) }
const has = (root, ref, f) => { try { sh(root, 'cat-file', '-e', `${ref}:${f}`); return true } catch { return false } }

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-mq-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  write(root, '.gitignore', '.claude/\n')
  write(root, 'a.txt', 'a\n')
  commit(root, 'init')
  return root
}

function runnerFor(project) {
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  runner.tick = () => {}
  runner.queue = []
  runner.mergeQueue = []
  return runner
}

// Tasks que partem todas do mesmo ponto da base e concluem juntas.
function finishAll(project, files, extra = {}) {
  const runner = runnerFor(project)
  const tasks = Object.entries(files).map(([title, f]) => {
    const t = createTask(project.path, { title, status: 'doing', ...extra.task })
    const ws = prepareWorkspace(project, t.id, extra.ws)
    write(ws.cwd, f, `${title}\n`); commit(ws.cwd, title)
    const a = {
      projectId: project.id, taskId: t.id, workspace: ws, taskRelPath: 'x.md', verify: null, review: { approved: true },
      result: {}, stderr: '', logEvents: [], logBytes: 0, logStream: null,
    }
    runner.actives.set(t.id, a)
    return a
  })
  extra.beforeFinish?.()
  for (const a of tasks) runner.finish(a, 0)
  return { runner, ids: tasks.map(a => a.taskId) }
}

// x.txt e z.txt passam sozinhos, mas não juntos.
const VERIFY = '! { test -f x.txt && test -f z.txt; }'

test('fila de merge: compatíveis entram em ordem; a que quebra junto volta com conflito', async () => {
  const root = repo()
  const project = { id: 'mq1', path: root, verifyCommand: VERIFY, git: { autoPush: false }, autopilot: { autoMerge: { enabled: true } } }
  const { runner, ids: [one, two, rival] } = finishAll(project, { um: 'x.txt', dois: 'y.txt', rival: 'z.txt' })
  assert.deepEqual(runner.getQueueView().merges.map(m => m.taskId), [one, two, rival], 'fila em ordem de chegada')
  await runner.mergeDrain

  assert.ok(has(root, 'main', 'x.txt') && has(root, 'main', 'y.txt'))
  assert.ok(!has(root, 'main', 'z.txt'), 'a que quebra junto não entra')
  for (const id of [one, two]) {
    const t = findTask(root, id)
    assert.equal(t.status, 'archived')
    assert.ok(t.run.merge_sha)
  }
  const log = sh(root, 'log', '--format=%s', 'main')
  assert.ok(log.indexOf(`kanban/${two}`) < log.indexOf(`kanban/${one}`), 'ordem de chegada')

  const t = findTask(root, rival)
  assert.equal(t.status, 'todo')
  assert.ok(t.tags.includes(CONFLICT_TAG))
  assert.equal(t.run.merge_from, 'main')
  assert.match(t.body, /quebra junto com o que já está em main/)
  assert.ok(runner.queue.some(q => q.taskId === rival), 'volta para a fila de execução')
  assert.deepEqual(runner.getQueueView().merges, [])
})

test('fila de merge: base que anda durante o verify refaz o item', async () => {
  const root = repo()
  const flag = path.join(root, '.claude', 'moved')
  fs.mkdirSync(path.dirname(flag), { recursive: true })
  // Na 1ª verificação, alguém commita na main.
  const verifyCommand = `test -f ${flag} || { touch ${flag}; git -C ${root} commit -q --allow-empty -m externo; }`
  const project = { id: 'mq2', path: root, verifyCommand, git: { autoPush: false }, autopilot: { autoMerge: { enabled: true } } }
  const { runner, ids: [id] } = finishAll(project, { um: 'x.txt' }, {
    beforeFinish: () => sh(root, 'commit', '-q', '--allow-empty', '-m', 'main anda antes'), // força merge não fast-forward
  })
  await runner.mergeDrain
  assert.equal(findTask(root, id).status, 'archived')
  assert.equal(sh(root, 'log', '-1', '--format=%P', 'main').split(' ').length, 2)
  assert.equal(sh(root, 'log', '-1', '--format=%s', 'main^1'), 'externo', 'mergeou em cima do commit novo')
})

test('fila de merge: subtask concluída segura o pai até integrar', async () => {
  const root = repo()
  const project = { id: 'mq3', path: root, verifyCommand: VERIFY }
  const pai = createTask(root, { title: 'Pai', status: 'todo' })
  const { runner, ids } = finishAll(project, { um: 'x.txt', rival: 'z.txt' },
    { task: { tags: ['subtask', `pai:${pai.id}`] }, ws: { parentId: pai.id } })
  updateTask(root, pai.id, { depends_on: ids })
  assert.deepEqual(runner.pendingDeps(project, pai.id), ids, 'concluídas, mas ainda na fila de merge')
  await runner.mergeDrain
  assert.ok(has(root, taskBranch(pai.id), 'x.txt'))
  assert.ok(!has(root, taskBranch(pai.id), 'z.txt'))
  const rival = findTask(root, ids[1])
  assert.equal(rival.run.exit_reason, 'integration_conflict')
  assert.equal(rival.run.merge_from, taskBranch(pai.id))
  assert.deepEqual(runner.pendingDeps(project, pai.id), [ids[1]], 'fora do ledger: o pai continua esperando')
})

function autopilotFor(project) {
  const queued = []
  const runner = { actives: new Map(), queue: [], enqueue: (_, id) => queued.push(id) }
  const ap = new Autopilot({ db: { projects: [project] }, saveProjects: () => {}, runner, emit: () => {} })
  return { ap, queued }
}

test('CI da base quebra no merge do autopilot: reverte e reabre a task com o log', async () => {
  const root = repo()
  const project = { id: 'mq4', name: 'P', path: root, git: { autoPush: false }, autopilot: { autoMerge: { enabled: true }, watchMainCI: true } }
  const { runner, ids: [id] } = finishAll(project, { quebra: 'x.txt' })
  await runner.mergeDrain
  const sha = findTask(root, id).run.merge_sha
  assert.equal(sha, sh(root, 'rev-parse', 'main'))
  fs.writeFileSync(path.join(FAKE, 'runs.json'), JSON.stringify([
    { status: 'completed', conclusion: 'failure', headSha: sha, workflowName: 'CI', url: 'https://x/actions/runs/5' },
  ]))

  const { ap, queued } = autopilotFor(project)
  await ap.tick()
  assert.ok(!has(root, 'main', 'x.txt'), 'revert entrou na base')
  assert.ok(sh(root, 'branch', '--list', `kanban/revert-${id}`))
  const t = findTask(root, id)
  assert.equal(t.status, 'todo')
  assert.ok(t.tags.includes(REVERTED_TAG) && !t.tags.includes('merged'))
  assert.equal(t.run.merge_sha, null)
  assert.match(t.body, new RegExp(`## ${PR_FEEDBACK}[\\s\\S]*revertido[\\s\\S]*git revert --no-edit[\\s\\S]*quebrou na main`))
  assert.deepEqual(queued, [id])

  // Mesmo run de novo: nada (nem revert, nem task de CI).
  project.autopilotState = {}
  await ap.tick()
  const { listTasks } = await import('../src/lib/tasks.js')
  assert.equal(listTasks(root).length, 1)
})

test('PR atrás da base é atualizada antes do merge; em dia, mergeia e guarda o sha', async () => {
  const origin = fs.mkdtempSync(path.join(tmpdir(), 'ck-mq-origin-'))
  sh(origin, 'init', '-q', '--bare', '-b', 'main')
  const root = repo()
  sh(root, 'remote', 'add', 'origin', origin)
  sh(root, 'push', '-q', 'origin', 'main')
  const head = sh(root, 'rev-parse', 'main')
  sh(root, 'commit', '-q', '--allow-empty', '-m', 'main anda')
  sh(root, 'push', '-q', 'origin', 'main')

  const project = { id: 'mq5', name: 'P', path: root, autopilot: { autoMerge: { enabled: true } } }
  const t = createTask(root, { title: 'Com PR', status: 'done' })
  updateTask(root, t.id, { run: { branch: `kanban/${t.id}`, pr: { number: 7, url: 'https://x/pr/7', state: 'OPEN' }, review_approved: true } })
  markSucceeded(t.id, {})
  fs.mkdirSync(path.dirname(diffFile(root, t.id)), { recursive: true })
  fs.writeFileSync(diffFile(root, t.id), 'diff --git a/x b/x\n+1\n')
  const setPR = headRefOid => fs.writeFileSync(path.join(FAKE, 'pr.json'), JSON.stringify({
    number: 7, url: 'https://x/pr/7', state: 'OPEN', headRefOid, mergeable: 'MERGEABLE', reviewDecision: '',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    comments: [], reviews: [], mergeCommit: { oid: 'm3rg3' },
  }))
  const ghLog = path.join(FAKE, 'gh.log')

  const { ap } = autopilotFor(project)
  setPR(head)
  fs.rmSync(ghLog, { force: true })
  await ap.tick()
  assert.match(fs.readFileSync(ghLog, 'utf8'), /pr update-branch 7/)
  assert.doesNotMatch(fs.readFileSync(ghLog, 'utf8'), /pr merge/)
  assert.equal(findTask(root, t.id).status, 'done')

  setPR(sh(root, 'rev-parse', 'main'))
  project.autopilotState = {}
  await ap.tick()
  assert.match(fs.readFileSync(ghLog, 'utf8'), /pr merge 7 --merge/)
  const done = findTask(root, t.id)
  assert.equal(done.status, 'archived')
  assert.equal(done.run.merge_sha, 'm3rg3')
})
