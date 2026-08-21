import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Precisa vir antes do import do app: paths.js lê a env no load para decidir
// onde ficam projects.json/state.json.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))

const { buildApp } = await import('../src/app.js')

// Stubs: as rotas só precisam da superfície que elas de fato chamam.
const runner = {
  getQueueView: () => ({ actives: [], queue: [] }),
  dropProject: () => {},
  readLog: () => [],
}
const devServers = { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] }

const db = { projects: [] }
const events = []
let app

before(async () => {
  app = await buildApp({ db, runner, devServers, emit: (type, payload) => events.push({ type, payload }) })
  await app.ready()
})
after(() => app.close())

const json = res => res.json()

test('fluxo criar projeto → criar task → mover status', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-proj-'))

  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'demo', path: root } })
  assert.equal(created.statusCode, 200)
  const project = json(created).project
  assert.equal(project.path, root)
  assert.equal(project.bootstrap, 'ok', 'criar projeto roda o bootstrap')

  const taskRes = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/tasks`,
    payload: { title: 'primeira', description: 'oi', priority: 'high' },
  })
  assert.equal(taskRes.statusCode, 200)
  const task = json(taskRes).task
  assert.equal(task.status, 'backlog')

  const moved = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${project.id}/tasks/${task.id}`,
    payload: { status: 'todo' },
  })
  assert.equal(moved.statusCode, 200)
  assert.equal(json(moved).task.status, 'todo')

  const list = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tasks` })
  assert.deepEqual(json(list).tasks.map(t => [t.id, t.status]), [[task.id, 'todo']])

  assert.deepEqual(
    events.map(e => e.type),
    ['task.upserted', 'task.moved', 'task.upserted'],
    'a mudança de status emite task.moved antes do upsert',
  )
})

test('erros: projeto inexistente, task sem título, modelo inválido', async () => {
  const notFound = await app.inject({ method: 'GET', url: '/api/projects/zzzzzz/tasks' })
  assert.equal(notFound.statusCode, 404)

  const p = db.projects[0]
  const noTitle = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/tasks`, payload: {} })
  assert.equal(noTitle.statusCode, 400)

  const badModel = await app.inject({
    method: 'POST',
    url: `/api/projects/${p.id}/tasks`,
    payload: { title: 'x', model: 'gpt-9' },
  })
  assert.equal(badModel.statusCode, 400)
  assert.match(json(badModel).error, /modelo inválido/)
})

test('health responde com claudeAvailable', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.deepEqual(json(res), { ok: true, claudeAvailable: true })
})

test('PATCH webhookUrl: aceita http(s), rejeita o resto, vazio desliga', async () => {
  const p = db.projects[0]
  const patch = webhookUrl => app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { webhookUrl } })

  assert.equal(json(await patch('https://hooks.example.com/x')).project.webhookUrl, 'https://hooks.example.com/x')
  assert.equal((await patch('ftp://nope')).statusCode, 400)
  assert.equal(json(await patch('')).project.webhookUrl, '')
})

test('PATCH webhookStatuses: só status válidos, vazio volta a notificar tudo', async () => {
  const p = db.projects[0]
  const patch = webhookStatuses => app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { webhookStatuses } })

  assert.deepEqual(json(await patch(['done'])).project.webhookStatuses, ['done'])
  assert.equal((await patch(['nao_existe'])).statusCode, 400)
  assert.equal((await patch('done')).statusCode, 400)
  assert.deepEqual(json(await patch([])).project.webhookStatuses, [])
})
