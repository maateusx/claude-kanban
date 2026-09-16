// Agregação dos metadados de execução que o Runner grava no frontmatter de cada
// task (`run.cost_usd`, `duration_ms`, `num_turns`, `attempts`, `exit_code`).
// O .md guarda apenas a ÚLTIMA execução de cada task — então "runs" aqui é
// sempre "tasks que já rodaram", não o histórico completo de execuções.

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// A execução conta a partir do momento em que terminou; se o .md não tem
// completed_at (sessão morta, task ainda rodando), cai para o started_at.
export function runAt(run) {
  const iso = run?.completed_at || run?.started_at
  const t = Date.parse(iso || '')
  return Number.isNaN(t) ? null : t
}

export function hasRun(task) {
  const r = task?.run
  if (!r) return false
  return runAt(r) != null || num(r.attempts) > 0 || r.cost_usd != null
}

// O que conta como "precisou de gente": tag de bloqueio/pedido ou motivo de
// saída que não se resolve sozinho.
const HUMAN_TAGS = ['blocked', 'human-request']
const HUMAN_REASONS = ['integration_conflict', 'goal_budget', 'max_turns']

const dayKey = ts => new Date(ts).toISOString().slice(0, 10)

// Soma um bucket (por dia/modelo/status) in-place.
function bump(map, key, run) {
  const b = map.get(key) || { runs: 0, costUsd: 0, durationMs: 0, numTurns: 0, attempts: 0, successes: 0 }
  b.runs += 1
  b.costUsd += num(run.cost_usd)
  b.durationMs += num(run.duration_ms)
  b.numTurns += num(run.num_turns)
  b.attempts += Math.max(1, num(run.attempts))
  if (run.exit_code === 0) b.successes += 1
  map.set(key, b)
  return b
}

const rows = (map, field) => [...map.entries()]
  .map(([k, v]) => ({ [field]: k, ...v }))
  .sort((a, b) => b.costUsd - a.costUsd)

/**
 * @param tasks  saída de listTasks()
 * @param days   janela em dias (a partir de agora); 0/null = tudo
 * @param defaultModel  modelo do projeto, usado quando a task não fixa um
 * @param now    injetável para teste
 */
export function computeStats(tasks, { days = 30, defaultModel = null, now = Date.now(), topN = 5 } = {}) {
  const window = Number(days) > 0 ? Number(days) : null
  const since = window ? now - window * 86400_000 : null

  // Task sem run nenhum não entra em conta alguma — só no denominador de "tasks".
  const runs = (tasks || [])
    .filter(hasRun)
    .filter(t => {
      if (!since) return true
      const at = runAt(t.run)
      return at != null && at >= since
    })

  const byDay = new Map()
  const byModel = new Map()
  const byStatus = new Map()
  const totals = { runs: 0, costUsd: 0, durationMs: 0, numTurns: 0, attempts: 0, successes: 0 }

  for (const t of runs) {
    const r = t.run
    const at = runAt(r)
    if (at != null) bump(byDay, dayKey(at), r)
    bump(byModel, t.model || defaultModel || 'default', r)
    bump(byStatus, t.status, r)
    totals.runs += 1
    totals.costUsd += num(r.cost_usd)
    totals.durationMs += num(r.duration_ms)
    totals.numTurns += num(r.num_turns)
    totals.attempts += Math.max(1, num(r.attempts))
    if (r.exit_code === 0) totals.successes += 1
  }

  // Métricas de autonomia: quanto passa de primeira, quanto acaba num humano e
  // quanto custa, com todas as tentativas, cada task que de fato concluiu.
  const done = runs.filter(t => t.status === 'done' || t.status === 'archived')
  const needsHuman = t => (t.tags || []).some(tag => HUMAN_TAGS.includes(tag)) || HUMAN_REASONS.includes(t.run.exit_reason)
  const byExitReason = new Map()
  for (const t of runs) {
    const k = t.run.exit_reason
    if (k) byExitReason.set(k, (byExitReason.get(k) || 0) + 1)
  }
  // Causas apontadas pelo diagnóstico automático (tags diagnosticada:<causa>).
  const byDiagnosis = new Map()
  for (const t of runs) {
    for (const tag of t.tags || []) {
      if (tag.startsWith('diagnosticada:')) byDiagnosis.set(tag.slice(14), (byDiagnosis.get(tag.slice(14)) || 0) + 1)
    }
  }
  const autonomy = {
    done: done.length,
    firstPassRate: done.length ? done.filter(t => num(t.run.attempts) <= 1).length / done.length : null,
    humanRate: runs.length ? runs.filter(needsHuman).length / runs.length : null,
    costPerDone: done.length ? done.reduce((sum, t) => sum + num(t.run.total_cost_usd ?? t.run.cost_usd), 0) / done.length : null,
    autoMerged: done.filter(t => (t.tags || []).includes('merged')).length,
    byExitReason: [...byExitReason.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    byDiagnosis: [...byDiagnosis.entries()].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n),
  }

  const top = runs
    .filter(t => num(t.run.cost_usd) > 0)
    .sort((a, b) => num(b.run.cost_usd) - num(a.run.cost_usd))
    .slice(0, topN)
    .map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      model: t.model || defaultModel || null,
      costUsd: num(t.run.cost_usd),
      durationMs: num(t.run.duration_ms),
      numTurns: num(t.run.num_turns),
      attempts: Math.max(1, num(t.run.attempts)),
      exitCode: t.run.exit_code ?? null,
      completedAt: t.run.completed_at || t.run.started_at || null,
    }))

  return {
    period: { days: window, since: since ? new Date(since).toISOString() : null },
    totals: {
      ...totals,
      tasks: (tasks || []).length,
      // Média por task que rodou — tasks sem run não puxam a média para baixo.
      avgCostUsd: totals.runs ? totals.costUsd / totals.runs : 0,
      // Aceite: exit 0 sobre o total de tentativas (retries contam no denominador).
      successRate: totals.attempts ? totals.successes / totals.attempts : null,
    },
    autonomy,
    byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: rows(byModel, 'model'),
    byStatus: rows(byStatus, 'status'),
    top,
  }
}
