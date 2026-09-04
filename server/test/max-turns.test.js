import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, findTask, updateTask } from '../src/lib/tasks.js'
import { Runner, turnLimit, DEFAULT_MAX_TURNS, MAX_MAX_TURNS } from '../src/lib/runner.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-turns-home-'))

test('turnLimit: default, 0 desliga, lixo cai no default, teto máximo', () => {
  assert.equal(turnLimit({}), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: null }), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: 'x' }), DEFAULT_MAX_TURNS)
  assert.equal(turnLimit({ maxTurns: 0 }), null)
  assert.equal(turnLimit({ maxTurns: 7 }), 7)
  assert.equal(turnLimit({ maxTurns: 9999 }), MAX_MAX_TURNS)
})

test('teto estourado bloqueia sem contar retentativa', () => {
  const project = { id: 'p1', path: mkdtempSync(path.join(tmpdir(), 'ck-turns-')), autoRun: true, maxTurns: 5 }
  const runner = new Runner(id => (id === project.id ? project : null), () => {})
  const { id: taskId } = createTask(project.path, { title: 'perdida', status: 'todo' })
  updateTask(project.path, taskId, { run: { attempts: 1 } })

  const a = { projectId: project.id, taskId, workspace: {}, stderr: '', result: { subtype: 'error_max_turns' } }
  runner.actives.set(taskId, a)
  runner.finish(a, 1)

  const task = findTask(project.path, taskId)
  assert.equal(task.status, 'todo')
  assert.ok(task.tags.includes('blocked'))
  assert.equal(task.scheduled_at, null) // nada de retry agendado
  assert.match(task.body, /Teto de 5 turnos atingido/)
})
