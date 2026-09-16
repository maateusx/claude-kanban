import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrapProject } from '../src/lib/bootstrap.js'
import { createTask, findTask, getSection } from '../src/lib/tasks.js'
import { Runner, buildRawPrompt, exitPlanText, rawModeOf } from '../src/lib/runner.js'

const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-raw-'))

function finishPlan(root, project, taskId, a = {}) {
  const emitted = []
  const runner = new Runner(() => project, (type, p) => emitted.push({ type, ...p }))
  runner.tick = () => {}
  const started = []
  runner.start = (...args) => started.push(args)
  const active = {
    projectId: project.id, taskId, workspace: { cwd: root }, taskRelPath: 'x.md',
    result: { session_id: 's1', result: 'resumo' }, stderr: '', logEvents: [], logBytes: 0, logStream: null,
    rawPhase: 'plan', plan: '1. fazer X', ...a,
  }
  runner.actives.set(taskId, active)
  runner.finish(active, 0)
  return { started, emitted }
}

test('rawModeOf aceita só os modos conhecidos', () => {
  assert.equal(rawModeOf({ rawMode: 'plan' }), 'plan')
  assert.equal(rawModeOf({ rawMode: 'off' }), null)
  assert.equal(rawModeOf({}), null)
})

test('prompt cru: título + descrição, sem instruções do kanban', () => {
  const task = { title: 'Somar', body: '\n## Descrição\n\nsoma a+b\n\n## Resultado\n' }
  assert.equal(buildRawPrompt(task, 'plan'), 'Somar\n\nsoma a+b')
  assert.match(buildRawPrompt(task, 'execute', 'P'), /soma a\+b[\s\S]*plano[\s\S]*P$/)
  assert.match(buildRawPrompt(task, 'execute', 'P', true), /Plano aprovado/)
})

test('exitPlanText lê o plano do tool_use ExitPlanMode', () => {
  const ev = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'P' } }] } }
  assert.equal(exitPlanText(ev), 'P')
  assert.equal(exitPlanText({ type: 'result' }), undefined)
})

test('plan: grava ## Plano e conclui a task', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'T', status: 'doing' })
  const { started } = finishPlan(root, { id: 'p1', path: root, rawMode: 'plan' }, t.id)
  const task = findTask(root, t.id)
  assert.equal(getSection(task.body, 'Plano'), '1. fazer X')
  assert.equal(task.status, 'done')
  assert.equal(started.length, 0)
})

test('plan-execute: grava o plano e retoma a sessão para executar', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'T', status: 'doing' })
  const { started } = finishPlan(root, { id: 'p1', path: root, rawMode: 'plan-execute' }, t.id)
  const task = findTask(root, t.id)
  assert.equal(getSection(task.body, 'Plano'), '1. fazer X')
  assert.equal(task.status, 'doing')
  assert.deepEqual(started, [['p1', t.id, { rawExec: { plan: '1. fazer X', sessionId: 's1' } }]])
})

test('execute cru: a resposta final vira ## Resultado', () => {
  const root = proj(); bootstrapProject(root)
  const t = createTask(root, { title: 'T', status: 'doing' })
  finishPlan(root, { id: 'p1', path: root, rawMode: 'execute' }, t.id, { rawPhase: 'execute' })
  const task = findTask(root, t.id)
  assert.equal(getSection(task.body, 'Resultado'), 'resumo')
  assert.equal(task.status, 'done')
})
