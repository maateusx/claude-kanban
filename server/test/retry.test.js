import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, findTask, updateTask } from '../src/lib/tasks.js'
import { Runner, retrySettings, DEFAULT_RETRY } from '../src/lib/runner.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-retry-home-'))
const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-retry-'))

// Simula o fim de um run que falhou (exit code 1), sem processo de verdade:
// finish() só precisa da entrada em actives e do id da task.
function failRun(runner, project, taskId) {
  const a = { projectId: project.id, taskId, workspace: {}, stderr: 'boom' }
  runner.actives.set(taskId, a)
  runner.finish(a, 1)
  return findTask(project.path, taskId)
}

function setup(retry, { autoRun = true } = {}) {
  const project = { id: 'p1', path: proj(), autoRun, retry }
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  const task = createTask(project.path, { title: 'falha', status: 'todo' })
  return { project, runner, taskId: task.id }
}

test('retrySettings cai nos defaults e valida os limites', () => {
  assert.deepEqual(retrySettings({}), DEFAULT_RETRY)
  assert.deepEqual(retrySettings({ retry: {} }), DEFAULT_RETRY)
  assert.deepEqual(retrySettings({ retry: { maxAttempts: 0 } }), DEFAULT_RETRY)
  assert.deepEqual(retrySettings({ retry: { maxAttempts: 'x', backoffMinutes: -1 } }), DEFAULT_RETRY)
  assert.deepEqual(retrySettings({ retry: { maxAttempts: 1, backoffMinutes: 5 } }), { maxAttempts: 1, backoffMinutes: 5 })
})

test('maxAttempts 1: primeira falha já marca blocked', () => {
  const { project, runner, taskId } = setup({ maxAttempts: 1, backoffMinutes: 0 })
  updateTask(project.path, taskId, { run: { attempts: 1 } })
  const task = failRun(runner, project, taskId)
  assert.equal(task.status, 'todo')
  assert.ok(task.tags.includes('blocked'))
  assert.equal(task.scheduled_at, null)
})

test('backoff reagenda a task no futuro enquanto sobrar tentativa', () => {
  const { project, runner, taskId } = setup({ maxAttempts: 3, backoffMinutes: 5 })
  updateTask(project.path, taskId, { run: { attempts: 1 } })
  const task = failRun(runner, project, taskId)
  assert.equal(task.status, 'todo')
  assert.ok(!task.tags.includes('blocked'))
  const delta = Date.parse(task.scheduled_at) - Date.now()
  assert.ok(delta > 4 * 60_000 && delta <= 5 * 60_000 + 5_000, `delta inesperado: ${delta}`)

  // Última tentativa: bloqueia em vez de reagendar.
  updateTask(project.path, taskId, { run: { attempts: 3 }, scheduled_at: null })
  const blocked = failRun(runner, project, taskId)
  assert.ok(blocked.tags.includes('blocked'))
  assert.equal(blocked.scheduled_at, null)
})

test('defaults preservam o comportamento atual: 3 tentativas, sem agendamento', () => {
  const { project, runner, taskId } = setup(undefined)
  for (const attempts of [1, 2]) {
    updateTask(project.path, taskId, { run: { attempts } })
    const t = failRun(runner, project, taskId)
    assert.ok(!t.tags.includes('blocked'))
    assert.equal(t.scheduled_at, null)
  }
  updateTask(project.path, taskId, { run: { attempts: 3 } })
  assert.ok(failRun(runner, project, taskId).tags.includes('blocked'))
})

test('sem auto-run não agenda backoff (o humano é quem re-executa)', () => {
  const { project, runner, taskId } = setup({ maxAttempts: 3, backoffMinutes: 5 }, { autoRun: false })
  updateTask(project.path, taskId, { run: { attempts: 1 } })
  assert.equal(failRun(runner, project, taskId).scheduled_at, null)
})
