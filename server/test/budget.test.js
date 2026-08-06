// Controles de custo: teto de turnos da sessão, modelo das sessões auxiliares e
// o que vai (ou não) para dentro do worktree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, findTask } from '../src/lib/tasks.js'
import { Runner, turnLimit, DEFAULT_MAX_TURNS, MAX_MAX_TURNS } from '../src/lib/runner.js'
import { auxModel, DEFAULT_AUX_MODEL } from '../src/lib/models.js'
import { copyClaudeDir } from '../src/lib/git.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-budget-home-'))
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ck-budget-'))

test('turnLimit: default, clamp e desligamento explícito', () => {
  assert.equal(turnLimit({}), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: null }), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: 'lixo' }), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: 25 }), 25)
  assert.equal(turnLimit({ maxTurns: 9999 }), MAX_MAX_TURNS)
  // 0 é a única forma de voltar ao comportamento antigo (só o timeout limita).
  assert.equal(turnLimit({ maxTurns: 0 }), null)
})

test('auxModel: sessões de leitura não herdam o modelo caro do projeto', () => {
  assert.equal(auxModel({ defaultModel: 'claude-opus-4-8' }), DEFAULT_AUX_MODEL)
  assert.equal(auxModel({ auxModel: 'claude-haiku-4-5-20251001' }), 'claude-haiku-4-5-20251001')
  assert.equal(auxModel({ auxModel: 'inexistente' }), DEFAULT_AUX_MODEL)
})

test('teto de turnos estourado bloqueia sem consumir retentativa', () => {
  const project = { id: 'p1', path: tmp(), autoRun: true, retry: { maxAttempts: 5, backoffMinutes: 10 } }
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  const { id: taskId } = createTask(project.path, { title: 'longa', status: 'doing' })

  const a = {
    projectId: project.id, taskId, workspace: {}, stderr: '',
    result: { type: 'result', subtype: 'error_max_turns' },
  }
  runner.actives.set(taskId, a)
  runner.finish(a, 1)

  const task = findTask(project.path, taskId)
  assert.equal(task.status, 'todo')
  // Ainda sobravam 4 tentativas, mas repetir pararia no mesmo ponto pelo mesmo preço.
  assert.ok(task.tags.includes('blocked'))
  assert.equal(task.scheduled_at, null)
})

test('worktree não recebe logs, diffs nem tasks concluídas', () => {
  const root = tmp()
  const kanban = path.join(root, '.claude', 'claude-kanban')
  fs.mkdirSync(path.join(kanban, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(kanban, 'diffs'), { recursive: true })
  fs.mkdirSync(path.join(kanban, 'tasks', 'done'), { recursive: true })
  fs.mkdirSync(path.join(kanban, 'tasks', 'doing'), { recursive: true })
  fs.writeFileSync(path.join(kanban, 'logs', 't1.jsonl'), 'x'.repeat(1000))
  fs.writeFileSync(path.join(kanban, 'diffs', 't1.diff'), 'diff')
  fs.writeFileSync(path.join(kanban, 'tasks', 'done', 'antiga.md'), '# antiga')
  fs.writeFileSync(path.join(kanban, 'tasks', 'doing', 'atual.md'), '# atual')
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}')

  const dest = path.join(tmp(), '.claude')
  copyClaudeDir(root, dest)

  const at = p => fs.existsSync(path.join(dest, 'claude-kanban', p))
  assert.ok(fs.existsSync(path.join(dest, 'settings.json')), 'settings precisa ir junto')
  assert.ok(at(path.join('tasks', 'doing', 'atual.md')), 'a task em andamento precisa ir junto')
  assert.ok(!at('logs'), 'logs de execução não vão para o worktree')
  assert.ok(!at('diffs'), 'diffs não vão para o worktree')
  assert.ok(!at(path.join('tasks', 'done')), 'tasks concluídas não vão para o worktree')
})
