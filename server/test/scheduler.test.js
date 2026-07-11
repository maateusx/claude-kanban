import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTask, findTask, updateTask } from '../src/lib/tasks.js'
import { Scheduler, dueTasks, parseWhen, isFuture } from '../src/lib/scheduler.js'
import { Runner } from '../src/lib/runner.js'

process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-sched-home-'))
const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-sched-'))

const past = () => new Date(Date.now() - 60_000).toISOString()
const future = () => new Date(Date.now() + 3600_000).toISOString()

test('parseWhen normaliza e rejeita lixo', () => {
  assert.equal(parseWhen('2026-03-01T10:00:00Z'), '2026-03-01T10:00:00.000Z')
  assert.equal(parseWhen('amanhã cedo'), null)
  assert.equal(parseWhen(null), null)
  assert.equal(isFuture(future()), true)
  assert.equal(isFuture(past()), false)
  assert.equal(isFuture(null), false)
})

test('dueTasks só pega backlog/todo com horário vencido e não bloqueadas', () => {
  const tasks = [
    { id: 'a', status: 'todo', scheduled_at: past() },
    { id: 'b', status: 'todo', scheduled_at: future() },
    { id: 'c', status: 'todo' },
    { id: 'd', status: 'doing', scheduled_at: past() },
    { id: 'e', status: 'backlog', scheduled_at: past() },
    { id: 'f', status: 'todo', scheduled_at: past(), tags: ['blocked'] },
  ]
  assert.deepEqual(dueTasks(tasks).map(t => t.id), ['a', 'e'])
})

// Runner falso: só registra o que seria enfileirado, sem spawnar o claude.
class FakeRunner {
  constructor() { this.enqueued = []; this.ticks = 0 }
  enqueue(projectId, taskId) { this.enqueued.push(taskId); return true }
  tick() { this.ticks++ }
}

test('scheduler enfileira a task vencida e limpa o horário', () => {
  const root = proj()
  const project = { id: 'p1', path: root }
  const db = { projects: [project] }
  const runner = new FakeRunner()
  const events = []
  const s = new Scheduler({ db, saveProjects: () => {}, runner, emit: (t, p) => events.push([t, p]) })

  const due = createTask(root, { title: 'vencida', status: 'todo', scheduled_at: past() })
  const later = createTask(root, { title: 'depois', status: 'todo', scheduled_at: future() })

  s.tick()

  assert.deepEqual(runner.enqueued, [due.id])
  assert.equal(findTask(root, due.id).scheduled_at, null)
  assert.ok(findTask(root, later.id).scheduled_at, 'a agendada para o futuro continua marcada')
  assert.ok(events.some(([t, p]) => t === 'task.upserted' && p.task.id === due.id))

  // Segundo tick não re-enfileira: o horário já foi consumido.
  s.tick()
  assert.deepEqual(runner.enqueued, [due.id])
})

test('scheduler limpa a pausa vencida do projeto e destrava a fila', () => {
  const root = proj()
  const project = { id: 'p1', path: root, queuePausedUntil: past() }
  const db = { projects: [project] }
  const runner = new FakeRunner()
  let saved = 0
  const s = new Scheduler({ db, saveProjects: () => { saved++ }, runner, emit: () => {} })

  s.tick()
  assert.equal(project.queuePausedUntil, null)
  assert.equal(saved, 1)
  assert.equal(runner.ticks, 1)

  // Pausa no futuro sobrevive ao tick.
  project.queuePausedUntil = future()
  s.tick()
  assert.ok(project.queuePausedUntil)
})

test('runner não solta tasks de projeto com fila adiada', () => {
  const root = proj()
  const paused = { id: 'p1', path: root, queuePausedUntil: future() }
  const runner = new Runner(() => paused, () => {})
  assert.equal(runner.eligible('p1'), false)

  paused.queuePausedUntil = past()
  assert.equal(runner.eligible('p1'), true)
})

test('scheduled_at sobrevive ao round-trip do .md como ISO string', () => {
  const root = proj()
  const t = createTask(root, { title: 'x', status: 'todo' })
  assert.equal(t.scheduled_at, null)

  const when = future()
  const scheduled = updateTask(root, t.id, { scheduled_at: when })
  assert.equal(scheduled.scheduled_at, when)
  assert.equal(typeof findTask(root, t.id).scheduled_at, 'string')

  assert.equal(updateTask(root, t.id, { scheduled_at: null }).scheduled_at, null)
})
