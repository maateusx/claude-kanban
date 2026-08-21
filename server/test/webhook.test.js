import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webhookUrl, webhookEventsFor } from '../src/lib/webhook.js'

test('webhookUrl só aceita http(s)', () => {
  assert.equal(webhookUrl({}), null)
  assert.equal(webhookUrl({ webhookUrl: '  ' }), null)
  assert.equal(webhookUrl({ webhookUrl: 'file:///etc/passwd' }), null)
  assert.equal(webhookUrl({ webhookUrl: ' https://x.dev/h ' }), 'https://x.dev/h')
})

test('run.finished: só falha e human-request viram webhook', () => {
  const ok = { type: 'run.finished', taskId: 't1', exitCode: 0 }
  assert.deepEqual(webhookEventsFor(ok), [])

  const human = webhookEventsFor({ ...ok, humanRequest: true })
  assert.equal(human[0].event, 'human_request')

  const failed = webhookEventsFor({ ...ok, exitCode: 1 })
  assert.deepEqual(failed, [{ event: 'run_failed', taskId: 't1', exitCode: 1, verifyFailed: false }])

  // verificação reprovada vem com exitCode 0 e ainda assim é falha
  const verify = webhookEventsFor({ ...ok, verifyFailed: true })
  assert.equal(verify[0].event, 'run_failed')
})

test('pending.updated: só pendentes e só uma vez por id', () => {
  const evt = {
    type: 'pending.updated',
    actions: [
      { id: 'pa-1', status: 'pending', label: 'rm -rf', command: 'rm -rf /', taskId: 't1' },
      { id: 'pa-2', status: 'done', label: 'resolvida' },
    ],
  }
  const seen = new Set()
  const first = webhookEventsFor(evt, seen)
  assert.equal(first.length, 1)
  assert.deepEqual(first[0], { event: 'pending_action', taskId: 't1', actionId: 'pa-1', label: 'rm -rf', command: 'rm -rf /' })
  seen.add('pa-1')
  assert.deepEqual(webhookEventsFor(evt, seen), [])
})

test('eventos sem interesse são ignorados', () => {
  assert.deepEqual(webhookEventsFor({ type: 'run.started', taskId: 't1' }), [])
  assert.deepEqual(webhookEventsFor({ type: 'task.upserted' }), [])
})
