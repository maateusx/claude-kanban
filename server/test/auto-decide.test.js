import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrapProject } from '../src/lib/bootstrap.js'
import { createTask, findTask, updateTask, replaceSection } from '../src/lib/tasks.js'
import { Runner, AUTO_DECIDE_RESPONSE, AUTO_DECIDED_TAG, MAX_AUTO_DECISIONS, HUMAN_REQUEST_TAG, consumeHumanAnswer } from '../src/lib/runner.js'

const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-autodecide-'))

// Termina um run com exit 0 num card que pediu decisão humana.
function finishWithRequest(root, project, taskId) {
  const emitted = []
  const runner = new Runner(() => project, (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {}
  runner.queue = []
  const a = {
    projectId: project.id, taskId, workspace: { cwd: root }, taskRelPath: 'x.md',
    result: {}, stderr: '', logEvents: [], logBytes: 0, logStream: null,
  }
  runner.actives.set(taskId, a)
  runner.finish(a, 0)
  return { runner, emitted }
}

const withRequest = (root, t) =>
  updateTask(root, t.id, { body: replaceSection(t.body, 'Human Request', 'A ou B?') })

test('autoDecide off: card volta para todo com a tag human-request', () => {
  const root = proj(); bootstrapProject(root)
  const t = withRequest(root, createTask(root, { title: 'Decidir', status: 'doing' }))

  const { runner, emitted } = finishWithRequest(root, { id: 'p1', path: root }, t.id)

  const task = findTask(root, t.id)
  assert.equal(task.status, 'todo')
  assert.ok(task.tags.includes(HUMAN_REQUEST_TAG))
  assert.equal(runner.queue.length, 0, 'espera um humano, não volta para a fila')
  assert.ok(emitted.some(e => e.type === 'run.finished' && e.humanRequest && !e.autoDecided))
})

test('autoDecide on: o próprio Claude responde e a task volta para a fila', () => {
  const root = proj(); bootstrapProject(root)
  const t = withRequest(root, createTask(root, { title: 'Decidir', status: 'doing' }))

  const { runner, emitted } = finishWithRequest(root, { id: 'p1', path: root, autoDecide: true }, t.id)

  const task = findTask(root, t.id)
  assert.equal(task.status, 'todo')
  assert.ok(!(task.tags || []).includes(HUMAN_REQUEST_TAG), 'ninguém precisa responder')
  assert.ok(task.tags.includes(AUTO_DECIDED_TAG), 'o card fica marcado como decidido sozinho')
  assert.match(task.body, /## Human Response/)
  assert.ok(task.body.includes(AUTO_DECIDE_RESPONSE))
  assert.deepEqual(runner.queue.map(q => q.taskId), [t.id])
  assert.ok(emitted.some(e => e.type === 'run.finished' && e.autoDecided))
})

test('autoDecide tem teto: depois de N decisões sozinho, o card espera um humano', () => {
  const root = proj(); bootstrapProject(root)
  const project = { id: 'p1', path: root, autoDecide: true }
  let t = createTask(root, { title: 'Loop', status: 'doing' })

  // Cada volta: o agente pergunta de novo, o orquestrador responde, o run
  // seguinte consome o par (arquivando no histórico).
  for (let i = 0; i < MAX_AUTO_DECISIONS; i++) {
    withRequest(root, findTask(root, t.id))
    finishWithRequest(root, project, t.id)
    assert.ok(!(findTask(root, t.id).tags || []).includes(HUMAN_REQUEST_TAG), `volta ${i + 1} decidida sozinha`)
    consumeHumanAnswer(root, t.id)
    updateTask(root, t.id, { status: 'doing' })
  }

  withRequest(root, findTask(root, t.id))
  const { runner } = finishWithRequest(root, project, t.id)
  const task = findTask(root, t.id)
  assert.ok(task.tags.includes(HUMAN_REQUEST_TAG), 'estourou o teto: para de decidir sozinho')
  assert.equal(runner.queue.length, 0)
})
