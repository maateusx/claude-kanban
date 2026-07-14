import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats, hasRun } from '../src/lib/stats.js'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const daysAgo = n => new Date(NOW - n * 86400_000).toISOString()

const t = (id, run, extra = {}) => ({ id, title: `task ${id}`, status: 'done', model: null, run, ...extra })

const SAMPLE = [
  t('a', { completed_at: daysAgo(1), cost_usd: 0.5, duration_ms: 60_000, num_turns: 10, attempts: 1, exit_code: 0 }),
  t('b', { completed_at: daysAgo(1), cost_usd: 1.5, duration_ms: 30_000, num_turns: 5, attempts: 2, exit_code: 0 },
    { model: 'claude-opus-4-8' }),
  t('c', { completed_at: daysAgo(2), cost_usd: 0.25, duration_ms: 10_000, num_turns: 2, attempts: 1, exit_code: 1 },
    { status: 'todo' }),
  t('d', { completed_at: daysAgo(40), cost_usd: 100, duration_ms: 1000, num_turns: 1, attempts: 1, exit_code: 0 }),
  // task nunca executada: só o run default
  t('e', { session_id: null, completed_at: null, cost_usd: null, attempts: 0, exit_code: null }, { status: 'backlog' }),
]

test('hasRun ignora tasks que nunca rodaram', () => {
  assert.equal(hasRun(SAMPLE[0]), true)
  assert.equal(hasRun(SAMPLE[4]), false)
  assert.equal(hasRun({ id: 'x' }), false) // sem bloco run nenhum
})

test('totais batem com a soma dos cost_usd na janela', () => {
  const s = computeStats(SAMPLE, { days: 30, now: NOW })
  assert.equal(s.totals.runs, 3)                 // d ficou fora da janela, e nunca rodou
  assert.equal(s.totals.tasks, 5)
  assert.equal(s.totals.costUsd, 0.5 + 1.5 + 0.25)
  assert.equal(s.totals.durationMs, 100_000)
  assert.equal(s.totals.numTurns, 17)
  assert.equal(s.totals.attempts, 4)             // 1 + 2 + 1
  assert.equal(s.totals.successes, 2)
  assert.equal(s.totals.successRate, 2 / 4)      // exit 0 sobre tentativas
  assert.equal(s.totals.avgCostUsd, 2.25 / 3)
})

test('days=0 pega o período inteiro', () => {
  const s = computeStats(SAMPLE, { days: 0, now: NOW })
  assert.equal(s.totals.runs, 4)
  assert.equal(s.totals.costUsd, 102.25)
  assert.equal(s.period.days, null)
  assert.equal(s.period.since, null)
})

test('board vazio e tasks sem run não quebram a conta', () => {
  const empty = computeStats([], { days: 7, now: NOW })
  assert.equal(empty.totals.costUsd, 0)
  assert.equal(empty.totals.avgCostUsd, 0)
  assert.equal(empty.totals.successRate, null)
  assert.deepEqual(empty.top, [])

  const onlyIdle = computeStats([SAMPLE[4], { id: 'z', title: 'z', status: 'backlog' }], { days: 7, now: NOW })
  assert.equal(onlyIdle.totals.runs, 0)
  assert.equal(onlyIdle.totals.tasks, 2)
  assert.equal(onlyIdle.totals.costUsd, 0)
})

test('agrupa por dia, modelo e status; top vem ordenado por custo', () => {
  const s = computeStats(SAMPLE, { days: 30, now: NOW, defaultModel: 'claude-sonnet-5' })

  assert.deepEqual(s.byDay.map(d => [d.date, d.costUsd, d.runs]), [
    [daysAgo(2).slice(0, 10), 0.25, 1],
    [daysAgo(1).slice(0, 10), 2, 2],
  ])

  // Task sem modelo próprio cai no default do projeto.
  assert.deepEqual(s.byModel.map(m => [m.model, m.costUsd]), [
    ['claude-opus-4-8', 1.5],
    ['claude-sonnet-5', 0.75],
  ])
  assert.deepEqual(s.byStatus.map(x => [x.status, x.runs]), [['done', 2], ['todo', 1]])

  assert.deepEqual(s.top.map(x => x.id), ['b', 'a', 'c'])
  assert.equal(s.top[0].costUsd, 1.5)
  assert.equal(s.top[0].model, 'claude-opus-4-8')
})

test('run só com started_at (sessão morta) ainda entra no período', () => {
  const s = computeStats([t('k', { started_at: daysAgo(1), completed_at: null, cost_usd: 0.1, attempts: 1, exit_code: null })],
    { days: 7, now: NOW })
  assert.equal(s.totals.runs, 1)
  assert.equal(s.totals.costUsd, 0.1)
  assert.equal(s.totals.successRate, 0)
  assert.equal(s.byDay[0].date, daysAgo(1).slice(0, 10))
})
