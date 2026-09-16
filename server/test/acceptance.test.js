// Critérios de aceite como teste: comando de aceite do objetivo e teste de
// reprodução obrigatório em tasks com tag bug.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CLAUDE_KANBAN_HOME = fs.mkdtempSync(path.join(tmpdir(), 'ck-acc-home-'))

const { createTask, findTask, updateTask } = await import('../src/lib/tasks.js')
const { prepareWorkspace, taskBranch } = await import('../src/lib/git.js')
const { Runner, sectionCommand, testFiles, acceptanceCommandOf, DECOMPOSED_TAG } = await import('../src/lib/runner.js')
const { buildReviewPrompt } = await import('../src/lib/reviewer.js')
const { designSubtask } = await import('../src/lib/decomposer.js')
const { DESIGN_TAG } = await import('../src/lib/spec.js')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, f, c) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
  fs.writeFileSync(path.join(dir, f), c)
}

function repo() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ck-acc-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  write(root, '.gitignore', '.claude/\n')
  write(root, 'a.txt', 'a\n')
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'init')
  return root
}

// "Sessão" que commita `files` na branch da task; depois o finish de verdade.
function runTask(project, task, files, parentId) {
  const ws = prepareWorkspace(project, task.id, { parentId })
  for (const [f, c] of Object.entries(files)) write(ws.cwd, f, c)
  sh(ws.cwd, 'add', '-A'); sh(ws.cwd, 'commit', '-q', '-m', 'sessão')
  const emitted = []
  const runner = new Runner(id => (id === project.id ? project : null), (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {}
  runner.queue = []
  const a = {
    projectId: project.id, taskId: task.id, workspace: ws, taskRelPath: 'x.md',
    result: {}, stderr: '', logEvents: [], logBytes: 0, logStream: null,
  }
  runner.actives.set(task.id, a)
  runner.finish(a, 0)
  return { task: findTask(project.path, task.id), a }
}

const withRepro = (root, t, cmd) =>
  updateTask(root, t.id, { body: `${t.body}\n## Teste de reprodução\n\n\`\`\`sh\n${cmd}\n\`\`\`\n` })

test('sectionCommand, testFiles e acceptanceCommandOf', () => {
  assert.equal(sectionCommand('## Comando de aceite\n\n```bash\nnpm run e2e\n```\n', 'Comando de aceite'), 'npm run e2e')
  assert.equal(sectionCommand('## Comando de aceite\n`npm test`\n## Outra', 'Comando de aceite'), 'npm test')
  assert.equal(sectionCommand('sem seção', 'Comando de aceite'), '')
  assert.deepEqual(testFiles(['src/a.js', 'test/a.test.js', 'src/b.spec.ts', 'e2e/x.js', '.claude/claude-kanban/spec/SPEC.md']),
    ['test/a.test.js', 'src/b.spec.ts', 'e2e/x.js'])
  const goal = { tags: [DECOMPOSED_TAG] }
  assert.equal(acceptanceCommandOf({ acceptanceCommand: 'npm run e2e' }, goal), 'npm run e2e')
  assert.equal(acceptanceCommandOf({ acceptanceCommand: 'npm run e2e' }, { tags: [] }), '', 'task comum não roda o do projeto')
  assert.equal(acceptanceCommandOf({}, { acceptance_command: 'x' }), 'x')
})

test('objetivo não fecha com o teste de aceite falhando', () => {
  const root = repo()
  const project = { id: 'ac1', path: root }
  const goal = createTask(root, { title: 'Objetivo', status: 'doing', tags: [DECOMPOSED_TAG] })
  updateTask(root, goal.id, { acceptance_command: 'grep -q pronto a.txt || { echo "not ok 1 - aceite"; exit 1; }' })
  const { task } = runTask(project, goal, { 'b.txt': 'b\n' })
  assert.equal(task.status, 'todo')
  assert.equal(task.run.exit_reason, 'verify_failed')
  assert.match(task.body, /Verificação falhou[\s\S]*not ok 1 - aceite/)
})

test('objetivo conclui com o comando de aceite do projeto passando; evidência fica para o revisor', () => {
  const root = repo()
  const project = { id: 'ac2', path: root, acceptanceCommand: 'grep -q pronto a.txt' }
  const goal = createTask(root, { title: 'Objetivo', status: 'doing', tags: [DECOMPOSED_TAG] })
  const { task, a } = runTask(project, goal, { 'a.txt': 'pronto\n' })
  assert.equal(task.status, 'done')
  assert.match(a.evidence[0], /Testes de aceite .*passaram/)
  assert.match(buildReviewPrompt({ title: 'x', body: '' }, 'diff', a.evidence), /<evidencia-dos-testes>[\s\S]*passaram/)
  assert.doesNotMatch(buildReviewPrompt({ title: 'x', body: '' }, 'diff'), /evidencia-dos-testes/)
})

test('bug sem teste que reproduz é reprovado', () => {
  const root = repo()
  const t = createTask(root, { title: 'Bug', status: 'doing', tags: ['bug'] })
  const { task } = runTask({ id: 'bg1', path: root }, t, { 'a.txt': 'fixed\n' })
  assert.equal(task.status, 'todo')
  assert.match(task.body, /sem teste que reproduz/)
})

test('bug cujo teste passa na base é reprovado (arquivos de teste vão para a base)', () => {
  const root = repo()
  const t = withRepro(root, createTask(root, { title: 'Bug', status: 'doing', tags: ['bug'] }), 'sh test/repro.sh')
  // Só passa na base se o arquivo de teste for copiado para lá.
  const { task } = runTask({ id: 'bg2', path: root }, t, { 'a.txt': 'fixed\n', 'test/repro.sh': 'test -f a.txt\n' })
  assert.equal(task.status, 'todo')
  assert.match(task.body, /não reproduz o bug/)
})

test('bug com teste que falha na base e passa na branch conclui', () => {
  const root = repo()
  const t = withRepro(root, createTask(root, { title: 'Bug', status: 'doing', tags: ['bug'] }), 'sh test/repro.sh')
  const { task, a } = runTask({ id: 'bg3', path: root }, t, { 'a.txt': 'fixed\n', 'test/repro.sh': 'grep -q fixed a.txt\n' })
  assert.equal(task.status, 'done')
  assert.match(a.logEvents.find(e => e.type === 'verify').text, /Falha na base/)
})

test('subtask de desenho registra o comando de aceite no objetivo', () => {
  const root = repo()
  const project = { id: 'ds1', path: root, git: { autoPush: false } }
  const goal = createTask(root, { title: 'Objetivo', description: 'Critério: exporta CSV', status: 'todo' })
  const d = designSubtask(goal)
  assert.match(d.description, /testes de aceite[\s\S]*Comando de aceite[\s\S]*exporta CSV/)
  const design = createTask(root, {
    title: d.title, status: 'doing', tags: ['subtask', `pai:${goal.id}`, DESIGN_TAG],
    description: `${d.description}\n\n## Comando de aceite\n\n\`\`\`\nnpm run e2e\n\`\`\``,
  })
  const { task } = runTask(project, design, { 'e2e/csv.test.js': 'test.skip()\n' }, goal.id)
  assert.equal(task.status, 'done')
  assert.equal(findTask(root, goal.id).acceptance_command, 'npm run e2e')
  assert.ok(sh(root, 'branch', '--list', taskBranch(goal.id)))
})
