import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Precisa vir antes do import do app: paths.js lê a env no load para decidir
// onde ficam projects.json/state.json.
process.env.CLAUDE_KANBAN_HOME = mkdtempSync(path.join(tmpdir(), 'ck-home-'))

const { buildApp } = await import('../src/app.js')

const runner = {
  getQueueView: () => ({ actives: [], queue: [] }),
  dropProject: () => {},
  readLog: () => [],
}
const devServers = { isRunning: () => false, stop: () => false, status: () => ({}), logs: () => [] }

let app

before(async () => {
  app = await buildApp({ db: { projects: [] }, runner, devServers, emit: () => {} })
  await app.ready()
})
after(() => app.close())

test('origin de fora da allowlist recebe 403', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { origin: 'https://evil.com', host: '127.0.0.1:4400' },
  })
  assert.equal(res.statusCode, 403)
})

test('POST cross-site é bloqueado (CSRF)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { origin: 'https://evil.com', host: '127.0.0.1:4400' },
    payload: { name: 'x', path: '/tmp/x' },
  })
  assert.equal(res.statusCode, 403)
})

test('origin da UI (:5544) passa — o proxy do Vite continua funcionando', async () => {
  for (const origin of ['http://localhost:5544', 'http://127.0.0.1:5544']) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin, host: 'localhost:5544' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['access-control-allow-origin'], origin)
  }
})

test('requisição sem origin (curl, same-origin) passa', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { host: '127.0.0.1:4400' },
  })
  assert.equal(res.statusCode, 200)
})

test('host que não é localhost recebe 403 (DNS rebinding)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { host: 'evil.example.com:4400' },
  })
  assert.equal(res.statusCode, 403)
})
