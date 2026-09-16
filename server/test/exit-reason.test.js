import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, findTask, updateTask } from '../src/lib/tasks.js'
import { Runner, exitReason } from '../src/lib/runner.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-exit-home-'))

test('exitReason: classifica o motivo do fim do run', () => {
  assert.equal(exitReason({}, 0), null)
  assert.equal(exitReason({}, 0, { ok: false }), 'verify_failed')
  assert.equal(exitReason({ timedOut: true, killed: true }, null), 'timeout')
  assert.equal(exitReason({ killed: true }, null), 'killed')
  assert.equal(exitReason({ result: { subtype: 'error_max_turns' } }, 1), 'max_turns')
  assert.equal(exitReason({ result: { subtype: 'error_max_budget_usd' } }, 1), 'max_budget')
  assert.equal(exitReason({ result: { subtype: 'error_during_execution' } }, 1), 'execution_error')
  assert.equal(exitReason({ result: { subtype: 'success', is_error: true } }, 1), 'api_error')
  assert.equal(exitReason({}, null), 'signal')
  assert.equal(exitReason({}, 1), 'exit_code')
})

test('falha grava exit_reason e a mensagem do result no log de erros', () => {
  const project = { id: 'p1', path: mkdtempSync(path.join(tmpdir(), 'ck-exit-')) }
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  const { id: taskId } = createTask(project.path, { title: 'sem crédito', status: 'todo' })
  updateTask(project.path, taskId, { run: { attempts: 1 } })

  const a = { projectId: project.id, taskId, workspace: {}, stderr: '',
    result: { subtype: 'success', is_error: true, result: 'Credit balance is too low' } }
  runner.actives.set(taskId, a)
  runner.finish(a, 1)

  const task = findTask(project.path, taskId)
  assert.equal(task.run.exit_reason, 'api_error')
  assert.match(task.body, /erro da API\/CLI do Claude \(exit code 1\)/)
  assert.match(task.body, /> Credit balance is too low/)
})
