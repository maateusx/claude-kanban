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

// O form de retentativas existia na UI desde sempre, mas o PATCH descartava o
// campo silenciosamente — não havia como baixar as retentativas de um projeto.
test('PATCH persiste retry e maxTurns e valida os limites', async () => {
  const p = db.projects[0]

  const ok = await app.inject({
    method: 'PATCH', url: `/api/projects/${p.id}`,
    payload: { retry: { maxAttempts: 1, backoffMinutes: 30 }, maxTurns: 25, auxModel: 'claude-haiku-4-5-20251001' },
  })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(json(ok).project.retry, { maxAttempts: 1, backoffMinutes: 30 })
  assert.equal(json(ok).project.maxTurns, 25)
  assert.equal(json(ok).project.auxModel, 'claude-haiku-4-5-20251001')

  // Patch parcial preserva o outro campo do retry.
  const partial = await app.inject({
    method: 'PATCH', url: `/api/projects/${p.id}`, payload: { retry: { maxAttempts: 3 } },
  })
  assert.deepEqual(json(partial).project.retry, { maxAttempts: 3, backoffMinutes: 30 })

  // 0 desliga o teto de turnos (volta ao comportamento antigo).
  const off = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { maxTurns: 0 } })
  assert.equal(json(off).project.maxTurns, 0)

  for (const payload of [{ retry: { maxAttempts: 0 } }, { retry: { backoffMinutes: -1 } }, { maxTurns: 9999 }]) {
    const bad = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload })
    assert.equal(bad.statusCode, 400, `esperava 400 para ${JSON.stringify(payload)}`)
  }
})

// Só o caminho de validação: instalar de verdade baixaria repositórios de
// terceiros, o que não cabe num teste.
test('PUT /plugins rejeita payload inválido antes de tocar no CLI', async () => {
  const p = db.projects[0]

  const semArray = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/plugins`, payload: {} })
  assert.equal(semArray.statusCode, 400)

  const desconhecido = await app.inject({
    method: 'PUT', url: `/api/projects/${p.id}/plugins`, payload: { enabled: ['ponytail', 'malware'] },
  })
  assert.equal(desconhecido.statusCode, 400)
  assert.match(json(desconhecido).error, /malware/)
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

test('create: true cria a pasta do projeto novo; sem a flag, path inexistente é erro', async () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ck-new-')), 'projeto-novo')

  const semFlag = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'novo', path: root } })
  assert.equal(semFlag.statusCode, 400)
  assert.match(json(semFlag).error, /não existe/)

  const comFlag = await app.inject({
    method: 'POST', url: '/api/projects', payload: { name: 'novo', path: root, create: true },
  })
  assert.equal(comFlag.statusCode, 200)
  assert.equal(json(comFlag).project.bootstrap, 'ok', 'pasta criada já sai com o board bootstrapado')
})
