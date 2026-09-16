// Autonomia, parte 2: verify de referência, escalação de modelo, sessão travada,
// resolução de conflito, auto-merge, acompanhamento de PR, entrada automática de
// trabalho, resumo diário, compactação de notas e métricas.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-home-'))

// gh e claude falsos no PATH: respondem a partir de arquivos em FAKE_DIR.
const FAKE = fs.mkdtempSync(path.join(tmpdir(), 'ck-fake-'))
process.env.FAKE_DIR = FAKE
fs.writeFileSync(path.join(FAKE, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = process.env.FAKE_DIR
const a = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'gh.log'), a.join(' ') + '\\n')
if (a[0] === 'pr' && a[1] === 'view' && /^\\d+$/.test(a[2])) process.stdout.write(fs.readFileSync(path.join(dir, 'pr.json')))
else if (a[0] === 'api') process.stdout.write('[]')
else if (a[0] === 'run' && a[1] === 'view') process.stdout.write('npm ERR! teste x falhou')
else if (a[0] === 'pr' && a[1] === 'merge') process.stdout.write('merged')
else process.exit(1)
`, { mode: 0o755 })
fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: '### Notas\\n- compacto', is_error: false }))
`, { mode: 0o755 })
process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`

const { createTask, findTask, updateTask } = await import('../src/lib/tasks.js')
const { prepareWorkspace, cleanupWorkspace, taskBranch, diffStats } = await import('../src/lib/git.js')
const {
  Runner, escalatedModel, stuckCheck, STUCK_REPEATS, STUCK_IDLE_TOOLS, newFailures, autoMergeBlocker,
  CONFLICT_TAG, PR_FEEDBACK, sandboxArgs, notesFile, exitReason,
} = await import('../src/lib/runner.js')
const { summarizePR } = await import('../src/lib/github.js')
const { Autopilot, buildDigest, digestDue, compactNotes, NOTES_COMPACT_AT, MAX_PR_ROUNDS } = await import('../src/lib/autopilot.js')
const { applyAutopilot } = await import('../src/routes/projects.js')
const { computeStats } = await import('../src/lib/stats.js')
const { markSucceeded, wasSucceeded } = await import('../src/lib/ledger.js')
const { kanbanDir, diffFile } = await import('../src/lib/paths.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c)
const commit = (dir, msg) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg) }

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  write(root, '.gitignore', '.claude/\n')
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

// Roda uma "sessão" que só commita `files` na branch da task e chama finish.
function runTask(project, task, files, extra = {}) {
  const ws = prepareWorkspace(project, task.id, { parentId: extra.parentId })
  for (const [f, c] of Object.entries(files)) write(ws.cwd, f, c)
  if (Object.keys(files).length) commit(ws.cwd, 'sessão')
  const { runner, emitted } = runnerFor(project)
  const a = active(project, task.id, { workspace: ws, ...extra.active })
  runner.actives.set(task.id, a)
  runner.finish(a, extra.exitCode ?? 0)
  return { task: findTask(project.path, task.id), runner, emitted, ws }
}

test('escalatedModel: só em retentativa, andando pela lista', () => {
  const p = { retry: { escalateModels: ['claude-sonnet-5', 'claude-opus-5', 'lixo'] } }
  assert.equal(escalatedModel(p, 1), null)
  assert.equal(escalatedModel(p, 2), 'claude-sonnet-5')
  assert.equal(escalatedModel(p, 3), 'claude-opus-5')
  assert.equal(escalatedModel(p, 9), 'claude-opus-5', 'fica no último')
  assert.equal(escalatedModel({}, 3), null)
})

test('stuckCheck: repetição idêntica e ociosidade sem edição', () => {
  const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
  const w = {}
  for (let i = 1; i < STUCK_REPEATS; i++) assert.equal(stuckCheck(w, use('Bash', { command: 'npm test' })), null)
  assert.match(stuckCheck(w, use('Bash', { command: 'npm test' })), /seguidas/)

  const w2 = {}
  for (let i = 1; i < STUCK_IDLE_TOOLS; i++) {
    assert.equal(stuckCheck(w2, use('Read', { file_path: `f${i}` })), null)
    if (i === 20) stuckCheck(w2, use('Edit', { file_path: 'x' })) // edição zera
  }
  assert.equal(w2.idle, STUCK_IDLE_TOOLS - 20 - 1)
  assert.equal(stuckCheck(w2, { type: 'user' }), null)
})

test('newFailures: ignora o que já falhava e durações', () => {
  const base = 'not ok 1 - soma (12ms)\n# fail 1'
  assert.deepEqual(newFailures('not ok 1 - soma (40ms)\n# fail 1', base), [])
  assert.deepEqual(newFailures('not ok 1 - soma\nnot ok 2 - sub\n# fail 2', base), ['not ok 2 - sub', '# fail 2'])
  assert.deepEqual(newFailures('sem palavra-chave', 'sem palavra-chave'), [])
  assert.equal(newFailures('outra coisa', 'sem palavra-chave').length, 1)
})

test('autoMergeBlocker e diffStats', () => {
  const diff = 'diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n+um\n-dois\n'
  assert.deepEqual(diffStats(diff), { files: ['src/x.js'], lines: 2 })
  const on = { autopilot: { autoMerge: { enabled: true, maxLines: 10 } } }
  assert.equal(autoMergeBlocker(on, { reviewApproved: true, diff }), null)
  assert.match(autoMergeBlocker({}, { reviewApproved: true, diff }), /desligado/)
  assert.match(autoMergeBlocker(on, { reviewApproved: null, diff }), /revisão/)
  assert.match(autoMergeBlocker({ autopilot: { autoMerge: { enabled: true, maxLines: 1 } } }, { reviewApproved: true, diff }), /linhas/)
  const wf = 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+x\n'
  assert.match(autoMergeBlocker(on, { reviewApproved: true, diff: wf }), /protegido/)
})

test('sandboxArgs: só com sandbox ligado, via --settings', () => {
  assert.deepEqual(sandboxArgs({}), [])
  const [flag, json] = sandboxArgs({ sandbox: true })
  assert.equal(flag, '--settings')
  assert.equal(JSON.parse(json).sandbox.allowUnsandboxedCommands, 'forbid')
})

test('verify de referência: falha que a base já tinha não conta contra a task', () => {
  const root = repo()
  const project = { id: 'vb1', path: root, verifyCommand: 'test -f ok.txt || { echo "not ok 1 - falta ok.txt"; exit 1; }' }
  const t = createTask(root, { title: 'Pré-existente', status: 'doing' })
  const { task, emitted } = runTask(project, t, { 'b.txt': 'b\n' })
  assert.equal(task.status, 'done')
  const ev = emitted.find(e => e.type === 'run.log' && e.event.type === 'verify')
  assert.equal(ev.event.ok, true)
  assert.match(ev.event.text, /já existiam na base/)
})

test('verify de referência: falha nova continua reprovando, com as linhas novas destacadas', () => {
  const root = repo()
  const project = {
    id: 'vb2', path: root,
    verifyCommand: 'r=0; test -f ok.txt || { echo "not ok 1 - falta ok.txt"; r=1; }; test ! -f bad.txt || { echo "not ok 2 - bad.txt"; r=1; }; exit $r',
  }
  const t = createTask(root, { title: 'Nova falha', status: 'doing' })
  const { task } = runTask(project, t, { 'bad.txt': 'x\n' })
  assert.equal(task.status, 'todo')
  assert.equal(task.run.exit_reason, 'verify_failed')
  assert.match(task.body, /Falhas novas[\s\S]*not ok 2 - bad\.txt/)
})

test('conflito na integração: agenda sessão de resolução e bloqueia depois do teto', () => {
  const root = repo()
  const project = { id: 'cf1', path: root, git: { autoPush: false } }
  const pai = createTask(root, { title: 'Pai', status: 'todo' })
  const filha = createTask(root, { title: 'Filha', status: 'doing', tags: ['subtask', `pai:${pai.id}`] })

  const ws = prepareWorkspace(project, filha.id, { parentId: pai.id })
  cleanupWorkspace(project, ws, 'nada.md')
  // A branch do pai anda com uma mudança conflitante.
  sh(root, 'checkout', '-q', taskBranch(pai.id)); write(root, 'a.txt', 'do pai\n'); commit(root, 'pai'); sh(root, 'checkout', '-q', 'main')

  const { task, runner } = runTask(project, filha, { 'a.txt': 'da filha\n' }, { parentId: pai.id })
  assert.equal(task.status, 'todo')
  assert.ok(task.tags.includes(CONFLICT_TAG))
  assert.ok(!task.tags.includes('blocked'))
  assert.equal(task.run.merge_from, taskBranch(pai.id))
  assert.equal(task.run.conflict_rounds, 1)
  assert.ok(runner.queue.some(q => q.taskId === filha.id), 'volta para a fila')

  updateTask(root, filha.id, { status: 'doing', run: { conflict_rounds: 2 } })
  const again = runTask(project, findTask(root, filha.id), { 'a.txt': 'da filha 2\n' }, { parentId: pai.id }).task
  assert.ok(again.tags.includes('blocked'), 'passou do teto: humano')
})

test('auto-merge local: revisão aprovada e diff pequeno vão direto para a base', () => {
  const root = repo()
  const project = { id: 'am1', path: root, git: { autoPush: false }, autopilot: { autoMerge: { enabled: true } } }
  const t = createTask(root, { title: 'Pequena', status: 'doing' })
  const { task } = runTask(project, t, { 'c.txt': 'c\n' }, { active: { review: { approved: true } } })
  assert.equal(task.status, 'archived')
  assert.ok(task.tags.includes('merged'))
  assert.equal(task.run.review_approved, true)
  assert.equal(sh(root, 'show', 'main:c.txt'), 'c')

  // Sem revisão aprovada, fica em done esperando o humano.
  const t2 = createTask(root, { title: 'Sem revisão', status: 'doing' })
  const r2 = runTask(project, t2, { 'd.txt': 'd\n' })
  assert.equal(r2.task.status, 'done')
  assert.throws(() => sh(root, 'show', 'main:d.txt'))
})

test('auto-merge com conflito na base agenda a resolução', () => {
  const root = repo()
  const project = { id: 'am2', path: root, git: { autoPush: false }, autopilot: { autoMerge: { enabled: true } } }
  const t = createTask(root, { title: 'Conflita', status: 'doing' })
  const ws = prepareWorkspace(project, t.id)
  write(ws.cwd, 'a.txt', 'da task\n'); commit(ws.cwd, 'task')
  write(root, 'a.txt', 'da main\n'); commit(root, 'main anda')
  const { runner } = runnerFor(project)
  const a = active(project, t.id, { workspace: ws, review: { approved: true } })
  runner.actives.set(t.id, a)
  runner.finish(a, 0)
  const task = findTask(root, t.id)
  assert.equal(task.status, 'todo')
  assert.equal(task.run.merge_from, 'main')
  assert.ok(!wasSucceeded(t.id), 'saiu do ledger para poder rodar de novo')
  assert.ok(runner.queue.some(q => q.taskId === t.id))
})

test('sessão travada conta como falha (não como cancelamento manual)', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-'))
  const project = { id: 'st1', path: root, retry: { maxAttempts: 3, backoffMinutes: 0 } }
  const t = createTask(root, { title: 'Loop', status: 'doing' })
  updateTask(root, t.id, { run: { attempts: 1 } })
  const { runner, emitted } = runnerFor(project)
  const a = active(project, t.id, { killed: true, stuck: 'Bash chamada 3x seguidas com o mesmo input' })
  assert.equal(exitReason(a, null, null), 'stuck')
  runner.actives.set(t.id, a)
  runner.finish(a, null)
  const task = findTask(root, t.id)
  assert.equal(task.status, 'todo')
  assert.equal(task.run.exit_reason, 'stuck')
  assert.match(task.body, /Sessão travada: Bash chamada 3x/)
  assert.ok(!emitted.some(e => e.type === 'run.killed'))
})

test('summarizePR: estado do CI, comentários novos e bots de fora', () => {
  const pr = {
    state: 'OPEN', headRefOid: 'abc', mergeable: 'MERGEABLE', reviewDecision: '',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u/actions/runs/1/job/2' },
      { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
    ],
    comments: [
      { createdAt: '2026-01-01T00:00:00Z', author: { login: 'ana' }, body: 'velho' },
      { createdAt: '2026-01-03T00:00:00Z', author: { login: 'ana' }, body: 'renomeie x' },
      { createdAt: '2026-01-03T00:00:00Z', author: { login: 'codecov' }, body: 'cobertura' },
    ],
    reviews: [],
  }
  const inline = [{ created_at: '2026-01-04T00:00:00Z', user: { login: 'bia' }, path: 'a.js', line: 3, body: 'bug aqui' }]
  const s = summarizePR(pr, inline, { commentsAt: '2026-01-02T00:00:00Z' })
  assert.equal(s.ci, 'failed')
  assert.deepEqual(s.failed.map(c => c.name), ['test'])
  assert.deepEqual(s.comments.map(c => c.body), ['renomeie x', 'a.js:3 — bug aqui'])
  assert.equal(s.latestCommentAt, '2026-01-04T00:00:00Z')

  pr.statusCheckRollup[0].status = 'IN_PROGRESS'
  assert.equal(summarizePR(pr).ci, 'pending')
  assert.equal(summarizePR({ ...pr, statusCheckRollup: [] }).ci, 'none')
})

function prProject(extra = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-'))
  const project = { id: `pr${Math.random().toString(36).slice(2, 7)}`, name: 'P', path: root, ...extra }
  const queued = []
  const runner = { actives: new Map(), queue: [], enqueue: (_, id) => queued.push(id) }
  const emitted = []
  const ap = new Autopilot({ db: { projects: [project] }, saveProjects: () => {}, runner, emit: (type, p) => emitted.push({ type, ...p }) })
  const t = createTask(root, { title: 'Com PR', status: 'done' })
  updateTask(root, t.id, { run: { branch: `kanban/${t.id}`, pr: { number: 7, url: 'https://x/pr/7', state: 'OPEN' }, review_approved: true } })
  markSucceeded(t.id, {})
  return { project, root, ap, queued, emitted, taskId: t.id }
}

const setPR = pr => fs.writeFileSync(path.join(FAKE, 'pr.json'), JSON.stringify({
  number: 7, url: 'https://x/pr/7', state: 'OPEN', headRefOid: 'sha1', mergeable: 'MERGEABLE',
  reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [], ...pr,
}))

test('PR com CI vermelho: task volta para a fila com o feedback', async () => {
  const { project, root, ap, queued, taskId } = prProject({ autopilot: { prFollowUp: true } })
  setPR({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'h/actions/runs/9' }] })
  await ap.tick()
  const t = findTask(root, taskId)
  assert.equal(t.status, 'todo')
  assert.match(t.body, new RegExp(`## ${PR_FEEDBACK}[\\s\\S]*CI falhou[\\s\\S]*npm ERR! teste x falhou`))
  assert.equal(t.run.pr_rounds, 1)
  assert.equal(t.run.pr_seen.failedSha, 'sha1')
  assert.ok(!wasSucceeded(taskId))
  assert.deepEqual(queued, [taskId])

  // Mesmo sha não reabre de novo; e passou do teto de rodadas, pede humano.
  updateTask(root, taskId, { status: 'done', run: { pr_rounds: MAX_PR_ROUNDS } })
  project.autopilotState = {}
  await ap.tick()
  assert.equal(findTask(root, taskId).status, 'done', 'mesmo sha: nada a fazer')
})

test('PR verde com política ok: autopilot mergeia', async () => {
  const { root, ap, taskId } = prProject({ autopilot: { autoMerge: { enabled: true } } })
  fs.mkdirSync(path.dirname(diffFile(root, taskId)), { recursive: true })
  fs.writeFileSync(diffFile(root, taskId), 'diff --git a/x b/x\n+1\n')
  setPR({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  fs.rmSync(path.join(FAKE, 'gh.log'), { force: true })
  await ap.tick()
  assert.match(fs.readFileSync(path.join(FAKE, 'gh.log'), 'utf8'), /pr merge 7 --merge/)
  const t = findTask(root, taskId)
  assert.equal(t.status, 'archived')
  assert.ok(t.tags.includes('merged'))
})

test('PR mergeada por fora: task arquiva', async () => {
  const { root, ap, taskId } = prProject({ autopilot: { prFollowUp: true } })
  setPR({ state: 'MERGED' })
  await ap.tick()
  const t = findTask(root, taskId)
  assert.equal(t.status, 'archived')
  assert.equal(t.run.pr.state, 'MERGED')
})

test('fonte com polling importa sozinha, sem duplicar', async () => {
  const server = http.createServer((_, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([{ title: 'Bug A', url: 'https://x/a' }, { title: 'Bug B', url: 'https://x/b' }]))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  after(() => server.close())
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-'))
  const project = {
    id: 'src1', name: 'S', path: root, autopilot: { importStatus: 'todo' },
    searchSources: [{ id: 's1', name: 'API', method: 'GET', url: `http://127.0.0.1:${server.address().port}/`, enabled: true, pollMinutes: 5 }],
  }
  const ap = new Autopilot({ db: { projects: [project] }, saveProjects: () => {}, runner: {}, emit: () => {} })
  const now = Date.now()
  await ap.tick(now)
  await ap.tick(now + 1000) // não venceu
  project.autopilotState = {}
  await ap.tick(now + 2000) // venceu de novo: dedupe pela tag
  const { listTasks } = await import('../src/lib/tasks.js')
  const tasks = listTasks(root)
  assert.deepEqual(tasks.map(t => t.title).sort(), ['Bug A', 'Bug B'])
  assert.ok(tasks.every(t => t.status === 'todo'))
})

test('resumo diário: conteúdo e horário', () => {
  const now = Date.parse('2026-09-16T12:00:00')
  const tasks = [
    { id: 'a', title: 'Feita', status: 'done', tags: [], run: { completed_at: new Date(now - 3600_000).toISOString(), cost_usd: 1.5 } },
    { id: 'b', title: 'Antiga', status: 'done', tags: [], run: { completed_at: '2020-01-01T00:00:00Z', cost_usd: 9 } },
    { id: 'c', title: 'Travou', status: 'todo', tags: ['blocked'], run: {} },
    { id: 'd', title: 'Pergunta', status: 'todo', tags: ['human-request'], run: {} },
  ]
  const d = buildDigest(tasks, now)
  assert.deepEqual(d.done.map(t => t.id), ['a'])
  assert.deepEqual(d.blocked.map(t => t.id), ['c'])
  assert.deepEqual(d.waiting.map(t => t.id), ['d'])
  assert.equal(d.costUsd, 1.5)
  assert.match(d.text, /1 concluída/)

  assert.equal(digestDue({ digestHour: null }, {}, now), false)
  assert.equal(digestDue({ digestHour: 18 }, {}, now), false, 'antes da hora')
  assert.equal(digestDue({ digestHour: 9 }, {}, now), true)
  assert.equal(digestDue({ digestHour: 9 }, { digest: new Date(now).toLocaleDateString('sv') }, now), false, 'já mandou hoje')
})

test('compactNotes reescreve notes.md grande e preserva o que chegou depois', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-ap-'))
  fs.mkdirSync(kanbanDir(root), { recursive: true })
  fs.writeFileSync(notesFile(root), 'x'.repeat(NOTES_COMPACT_AT + 1))
  await compactNotes({ id: 'n1', path: root })
  assert.match(fs.readFileSync(notesFile(root), 'utf8'), /^### Notas\n- compacto/)

  fs.writeFileSync(notesFile(root), 'pequeno')
  await compactNotes({ id: 'n1', path: root })
  assert.equal(fs.readFileSync(notesFile(root), 'utf8'), 'pequeno')
})

test('applyAutopilot valida e mescla', () => {
  const p = {}
  assert.equal(applyAutopilot(p, { prFollowUp: true, issuesMinutes: 30, autoMerge: { enabled: true, protectedPaths: ['db/**', ''] } }), null)
  assert.equal(applyAutopilot(p, { digestHour: 8 }), null)
  assert.deepEqual(p.autopilot, {
    prFollowUp: true, issuesMinutes: 30, digestHour: 8, autoMerge: { enabled: true, protectedPaths: ['db/**'] },
  })
  assert.match(applyAutopilot(p, { digestHour: 24 }), /digestHour/)
  assert.match(applyAutopilot(p, { importStatus: 'done' }), /importStatus/)
  assert.match(applyAutopilot(p, { suggestMax: 0 }), /suggestMax/)
})

test('métricas de autonomia', () => {
  const now = Date.now()
  const at = new Date(now).toISOString()
  const s = computeStats([
    { id: '1', status: 'done', tags: [], run: { completed_at: at, attempts: 1, total_cost_usd: 1, exit_code: 0 } },
    { id: '2', status: 'archived', tags: ['merged'], run: { completed_at: at, attempts: 2, total_cost_usd: 3, exit_code: 0 } },
    { id: '3', status: 'todo', tags: ['blocked'], run: { completed_at: at, attempts: 2, exit_code: 1, exit_reason: 'stuck' } },
    { id: '4', status: 'todo', tags: [], run: { completed_at: at, attempts: 1, exit_code: 0, exit_reason: 'review_rejected' } },
  ], { now })
  assert.equal(s.autonomy.done, 2)
  assert.equal(s.autonomy.firstPassRate, 0.5)
  assert.equal(s.autonomy.humanRate, 0.25)
  assert.equal(s.autonomy.costPerDone, 2)
  assert.equal(s.autonomy.autoMerged, 1)
  assert.deepEqual(s.autonomy.byExitReason.map(r => r.reason).sort(), ['review_rejected', 'stuck'])
})
