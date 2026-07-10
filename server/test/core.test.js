import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, updateTask, listTasks, loadTask, reconcileProject, findTask } from '../src/lib/tasks.js'
import { bootstrapProject, mergeSettings, uninstallFromSettings, bootstrapStatus } from '../src/lib/bootstrap.js'
import { listPendingActions, resolvePendingAction } from '../src/lib/pending.js'
import { tasksDir, pendingFile } from '../src/lib/paths.js'
import { Runner } from '../src/lib/runner.js'
import { markSucceeded, wasSucceeded, getExecuted, clearExecuted } from '../src/lib/ledger.js'

const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-core-'))
// Isola o ledger num tmp dir por invocação da suíte (paths.js lê a env na hora).
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))

test('bootstrap cria estrutura completa e é idempotente', () => {
  const root = proj()
  bootstrapProject(root)
  for (const s of ['backlog', 'todo', 'doing', 'done', 'archived']) {
    assert.ok(existsSync(tasksDir(root, s)))
  }
  assert.ok(existsSync(path.join(root, '.claude/claude-kanban/hooks/guard.mjs')))
  assert.ok(existsSync(path.join(root, '.claude/skills/claude-kanban/SKILL.md')))
  assert.ok(existsSync(pendingFile(root)))
  assert.equal(bootstrapStatus(root), 'ok')

  const s1 = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8'))
  bootstrapProject(root) // re-run
  const s2 = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8'))
  assert.deepEqual(s1, s2, 'bootstrap não deve duplicar hooks')
  assert.equal(s2.hooks.PreToolUse.length, 2)
})

test('merge preserva hooks do usuário; uninstall remove só os nossos', () => {
  const user = {
    permissions: { allow: ['Bash(npm *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'meu-hook.sh' }] }] },
  }
  const merged = mergeSettings(user)
  assert.deepEqual(merged.permissions, user.permissions)
  const cmds = merged.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
  assert.ok(cmds.includes('meu-hook.sh'))
  assert.equal(cmds.filter(c => c.includes('claude-kanban')).length, 2)

  const un = uninstallFromSettings(merged)
  const cmds2 = un.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
  assert.deepEqual(cmds2, ['meu-hook.sh'])
})

test('bootstrap aborta com settings.json inválido', () => {
  const root = proj()
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeFileSync(path.join(root, '.claude/settings.json'), '{ invalido')
  assert.throws(() => bootstrapProject(root), /settings\.json inválido/)
  assert.equal(readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), '{ invalido')
})

test('createTask gera .md com frontmatter e nome slug--id', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'Refatorar pipeline de RAG', priority: 'high', tags: ['rag'], status: 'todo' })
  assert.match(path.basename(t.filePath), /^refatorar-pipeline-de-rag--\w{6}\.md$/)
  assert.equal(t.status, 'todo')
  assert.ok(t.filePath.includes('/tasks/todo/'))
  const raw = readFileSync(t.filePath, 'utf8')
  assert.match(raw, /id: \w{6}/)
  assert.match(raw, /## Descrição/)
})

test('updateTask com status move arquivo de pasta', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'X', status: 'backlog' })
  const t2 = updateTask(root, t.id, { status: 'doing' })
  assert.ok(t2.filePath.includes('/tasks/doing/'))
  assert.ok(!existsSync(t.filePath))
  assert.equal(t2.status, 'doing')
})

test('reconciliação: pasta vence sobre frontmatter', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'Y', status: 'todo' })
  // simula move manual do arquivo para done/ sem tocar no frontmatter
  const dest = path.join(tasksDir(root, 'done'), path.basename(t.filePath))
  renameSync(t.filePath, dest)
  const loaded = loadTask(root, dest)
  assert.equal(loaded.status, 'done')
  assert.match(readFileSync(dest, 'utf8'), /status: done/)
})

test('watcher adoption: arquivo cru sem frontmatter ganha id e status da pasta', () => {
  const root = proj(); bootstrapProject(root)
  const f = path.join(tasksDir(root, 'backlog'), 'ideia-nova.md')
  writeFileSync(f, '## Descrição\n\nFazer algo legal.\n')
  const t = loadTask(root, f)
  assert.match(t.id, /^\w{6}$/)
  assert.equal(t.status, 'backlog')
  assert.ok(t.title.length > 0)
})

test('reconcileProject regenera id duplicado', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'Original', status: 'todo' })
  const copy = path.join(tasksDir(root, 'backlog'), 'copia--' + t.id + '.md')
  writeFileSync(copy, readFileSync(t.filePath, 'utf8').replace('status: todo', 'status: backlog'))
  const tasks = reconcileProject(root)
  const ids = tasks.map(x => x.id)
  assert.equal(new Set(ids).size, ids.length, 'ids devem ser únicos')
  assert.equal(tasks.length, 2)
})

test('pending-actions: parse e resolve', () => {
  const root = proj(); bootstrapProject(root)
  writeFileSync(pendingFile(root), `
## [pa-abc123] 2026-07-10T16:02:11Z — deletar arquivo externo
- comando bloqueado: \`rm /tmp/x\`
- task: k7x2m9
- status: pending
`)
  let actions = listPendingActions(root)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'pa-abc123')
  assert.equal(actions[0].command, 'rm /tmp/x')
  assert.equal(actions[0].taskId, 'k7x2m9')
  assert.equal(actions[0].status, 'pending')

  assert.ok(resolvePendingAction(root, 'pa-abc123'))
  actions = listPendingActions(root)
  assert.equal(actions[0].status, 'done')
  assert.ok(!resolvePendingAction(root, 'pa-abc123'), 'não resolve duas vezes')
})

test('ledger: sucesso trava re-execução automática; explícito libera', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'Ledger', status: 'todo' })
  const emitted = []
  const runner = new Runner(() => ({ id: 'p1', path: root }), (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {} // não dispara execução real do claude neste teste unitário

  // ainda não executado: enfileira normalmente
  assert.equal(runner.enqueue('p1', t.id, { auto: true }), true)
  runner.queue = []

  // marca como concluído com sucesso
  markSucceeded(t.id, { completedAt: 'now' })
  assert.ok(wasSucceeded(t.id))

  // caminho automático: NÃO re-executa e reconcilia status perdido para done
  updateTask(root, t.id, { status: 'todo' }) // simula status perdido
  assert.equal(runner.enqueue('p1', t.id, { auto: true }), false)
  assert.equal(findTask(root, t.id).status, 'done')
  assert.ok(emitted.some(e => e.type === 'task.upserted' && e.task?.status === 'done'))

  // pedido explícito do usuário: limpa o ledger e permite novo run
  assert.equal(runner.enqueue('p1', t.id), true)
  assert.equal(getExecuted(t.id), null)
})

test('ledger: recover reconcilia doing concluído para done, não para todo', () => {
  const root = proj(); bootstrapProject(root)
  const done = createTask(root, { title: 'Done preso', status: 'doing' })
  const fail = createTask(root, { title: 'Falhou preso', status: 'doing' })
  markSucceeded(done.id, { completedAt: 'now' })
  clearExecuted(fail.id)

  const runner = new Runner(() => null, () => {})
  runner.recover([{ id: 'p1', path: root }])

  assert.equal(findTask(root, done.id).status, 'done')
  assert.equal(findTask(root, fail.id).status, 'todo')
})
