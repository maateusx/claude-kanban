import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { listTasks, createTask, updateTask, replaceSection } from './tasks.js'
import { clearExecuted } from './ledger.js'
import {
  prStatus, prInlineComments, mergePR, summarizePR, failedRunLog, latestRun, listIssues, issueTag, issueDescription,
} from './github.js'
import { fetchSource, itemDescription } from './searchFetch.js'
import { listSearchSources } from './searchSources.js'
import { analyzeProject } from './analyzer.js'
import { autoMergeBlocker, autoMergeSettings, notesFile, PR_FEEDBACK } from './runner.js'
import { gitSettings } from './git.js'
import { diffFile } from './paths.js'
import { auxModel } from './models.js'
import { postWebhook, webhookUrl } from './webhook.js'

// Autopilot: o que roda sem ninguém pedir, em intervalos. Entrada de trabalho
// (issues, fontes, CI quebrado na base, sugestões) e fechamento do ciclo depois
// da PR (CI, comentários, merge). Cada job é best-effort: falhar num projeto
// não para os outros, e o próximo tick tenta de novo.
export const TICK_MS = 60_000
const PR_EVERY_MS = 3 * 60_000
const CI_EVERY_MS = 5 * 60_000
const NOTES_EVERY_MS = 60 * 60_000
export const MAX_PR_ROUNDS = 3
export const NOTES_COMPACT_AT = 9000
export const SUGGESTED_TAG = 'auto-sugestao'
const IMPORT_STATUSES = ['backlog', 'todo']

export const DEFAULT_AUTOPILOT = {
  prFollowUp: false,       // CI/comentários da PR reabrem a task
  issuesLabel: '',         // importa issues com esta label…
  issuesMinutes: 0,        // …a cada N min (0 = desligado)
  watchMainCI: false,      // CI vermelho na base vira task urgente
  suggestHours: 0,         // ✨ Suggest agendado (0 = desligado)
  suggestMax: 5,           // teto de sugestões abertas ao mesmo tempo
  importStatus: 'backlog', // onde entra o que chega sozinho
  digestHour: null,        // hora local do resumo diário por webhook
}

export const autopilotSettings = p => ({
  ...DEFAULT_AUTOPILOT, ...(p?.autopilot || {}), autoMerge: autoMergeSettings(p),
})

const due = (at, everyMs, now) => !at || now - Date.parse(at) >= everyMs
const tagsOf = tasks => new Set(tasks.flatMap(t => t.tags || []))

export class Autopilot {
  constructor({ db, saveProjects, runner, emit, claudeAvailable = () => true }) {
    Object.assign(this, { db, saveProjects, runner, emit, claudeAvailable })
    this.running = new Set() // `${projectId}:${job}` em andamento
    this.timer = null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  // Dispara os jobs vencidos. Devolve as promises (os testes esperam por elas).
  tick(now = Date.now()) {
    const jobs = []
    for (const p of this.db.projects) {
      if (!fs.existsSync(p.path)) continue
      const s = autopilotSettings(p)
      const st = p.autopilotState || {}
      const run = (name, cond, fn) => {
        const key = `${p.id}:${name}`
        if (!cond || this.running.has(key)) return
        this.running.add(key)
        this.stamp(p, name, now)
        jobs.push(Promise.resolve().then(fn)
          .catch(e => console.error(`autopilot ${name} (${p.name}): ${e.message}`))
          .finally(() => this.running.delete(key)))
      }
      const hasPR = s.prFollowUp || s.autoMerge.enabled
      run('pr', hasPR && due(st.pr, PR_EVERY_MS, now), () => this.followPRs(p, s))
      run('issues', s.issuesLabel && s.issuesMinutes > 0 && due(st.issues, s.issuesMinutes * 60_000, now),
        () => this.pollIssues(p, s))
      run('ci', s.watchMainCI && due(st.ci, CI_EVERY_MS, now), () => this.watchCI(p, s))
      run('suggest', s.suggestHours > 0 && this.claudeAvailable() && due(st.suggest, s.suggestHours * 3600_000, now),
        () => this.suggest(p, s))
      run('notes', this.claudeAvailable() && due(st.notes, NOTES_EVERY_MS, now), () => compactNotes(p))
      run('digest', digestDue(s, st, now) && webhookUrl(p), () => this.digest(p, now))
      for (const src of listSearchSources(p)) {
        const min = Number(src.pollMinutes) || 0
        run(`source:${src.id}`, src.enabled && min > 0 && due(st[`source:${src.id}`], min * 60_000, now),
          () => this.pollSource(p, s, src))
      }
    }
    return Promise.all(jobs)
  }

  stamp(p, name, now) {
    p.autopilotState = { ...(p.autopilotState || {}), [name]: name === 'digest' ? localDay(now) : new Date(now).toISOString() }
    this.saveProjects(this.db)
  }

  created(p, task) {
    this.emit('task.upserted', { projectId: p.id, task })
    return task
  }

  // ---- PR: CI, comentários, conflito e merge ----

  // ponytail: gh síncrono (execFileSync), uma PR por vez — trava o event loop
  // alguns segundos a cada 3 min com muitas PRs abertas; vira execFile se pesar.
  followPRs(p, s) {
    const busy = id => this.runner.actives.has(id) || this.runner.queue.some(q => q.taskId === id)
    const tasks = listTasks(p.path).filter(t =>
      t.status === 'done' && t.run?.pr?.number && (t.run.pr.state ?? 'OPEN') === 'OPEN' && !busy(t.id))
    for (const t of tasks) {
      const n = t.run.pr.number
      let sum
      try { sum = summarizePR(prStatus(p.path, n), prInlineComments(p.path, n), t.run.pr_seen || {}) } catch { continue }

      if (sum.state !== 'OPEN') {
        const merged = sum.state === 'MERGED'
        const u = updateTask(p.path, t.id, {
          run: { pr: { ...t.run.pr, state: sum.state } },
          ...(merged ? { status: 'archived', tags: [...new Set([...(t.tags || []), 'merged'])] } : {}),
        })
        if (merged) this.emit('task.moved', { projectId: p.id, taskId: t.id, from: 'done', to: 'archived' })
        this.emit('task.upserted', { projectId: p.id, task: u })
        continue
      }

      const seen = t.run.pr_seen || {}
      const ciFailed = s.prFollowUp && sum.ci === 'failed' && seen.failedSha !== sum.sha
      const commented = s.prFollowUp && sum.comments.length > 0
      const conflict = sum.conflicting && seen.conflictSha !== sum.sha
      if (ciFailed || commented || conflict) {
        const nextSeen = {
          ...seen,
          commentsAt: sum.latestCommentAt,
          ...(ciFailed ? { failedSha: sum.sha } : {}),
          ...(conflict ? { conflictSha: sum.sha } : {}),
        }
        if ((t.run.pr_rounds || 0) >= MAX_PR_ROUNDS) {
          if (!seen.gaveUp) {
            updateTask(p.path, t.id, { run: { pr_seen: { ...nextSeen, gaveUp: true } } })
            this.emit('pr.attention', { projectId: p.id, taskId: t.id, url: t.run.pr.url,
              reason: `a PR recebeu feedback ${MAX_PR_ROUNDS}x e ainda não passou — precisa de um humano` })
          }
          continue
        }
        const base = gitSettings(p).baseBranch
        this.reopen(p, t, prFeedback(t, sum, { ciFailed, commented, conflict, base, cwd: p.path }), {
          pr_seen: nextSeen,
          pr_rounds: (t.run.pr_rounds || 0) + 1,
          ...(conflict ? { merge_from: `origin/${base}` } : {}),
        })
        continue
      }

      const ciOk = sum.ci === 'passed' || sum.ci === 'none'
      if (!ciOk || sum.changesRequested || sum.conflicting) continue
      let diff = ''
      try { diff = fs.readFileSync(diffFile(p.path, t.id), 'utf8') } catch {}
      if (autoMergeBlocker(p, { reviewApproved: t.run.review_approved, diff })) continue
      try { mergePR(p.path, n) } catch (e) {
        console.error(`autopilot: merge da PR #${n} falhou: ${e.message}`)
        continue
      }
      const u = updateTask(p.path, t.id, {
        status: 'archived',
        tags: [...new Set([...(t.tags || []), 'merged'])],
        run: { pr: { ...t.run.pr, state: 'MERGED' } },
      })
      this.emit('task.moved', { projectId: p.id, taskId: t.id, from: 'done', to: 'archived' })
      this.emit('task.upserted', { projectId: p.id, task: u })
    }
  }

  // A task volta para a fila com o feedback no corpo; o run seguinte trabalha
  // na mesma branch e dá push na mesma PR.
  reopen(p, t, feedback, run) {
    const task = updateTask(p.path, t.id, {
      status: 'todo', scheduled_at: null, run,
      body: replaceSection(t.body, PR_FEEDBACK, feedback),
    })
    clearExecuted(t.id)
    this.emit('task.moved', { projectId: p.id, taskId: t.id, from: t.status, to: 'todo' })
    this.emit('task.upserted', { projectId: p.id, task })
    this.runner.enqueue(p.id, t.id)
  }

  // ---- entrada de trabalho ----

  pollIssues(p, s) {
    const tasks = listTasks(p.path)
    const have = tagsOf(tasks)
    for (const issue of listIssues(p.path, { label: s.issuesLabel })) {
      if (have.has(issueTag(issue.number))) continue
      this.created(p, createTask(p.path, {
        title: issue.title, description: issueDescription(issue), priority: 'medium',
        tags: ['issue', issueTag(issue.number)], status: importStatus(s),
      }))
    }
  }

  async pollSource(p, s, source) {
    const items = await fetchSource(source)
    const have = tagsOf(listTasks(p.path))
    for (const item of items) {
      if (have.has(item.tag)) continue
      have.add(item.tag)
      this.created(p, createTask(p.path, {
        title: item.title, description: itemDescription(item), priority: 'medium',
        tags: ['search', item.tag], status: importStatus(s),
      }))
    }
  }

  watchCI(p, s) {
    const base = gitSettings(p).baseBranch
    const run = latestRun(p.path, base)
    if (run?.conclusion !== 'failure' || !run.headSha) return
    const tag = `ci:${run.headSha.slice(0, 10)}`
    if (tagsOf(listTasks(p.path)).has(tag)) return
    const log = failedRunLog(p.path, run.url)
    this.created(p, createTask(p.path, {
      title: `CI quebrado em ${base}: ${run.workflowName || 'workflow'}`,
      description: `O workflow **${run.workflowName || '?'}** falhou em \`${base}\` no commit \`${run.headSha.slice(0, 10)}\` ` +
        `([run](${run.url})). Descubra a causa e corrija.\n\n` +
        (log ? `Cauda do log das etapas que falharam:\n\n\`\`\`\n${log}\n\`\`\`` : 'Veja o log com `gh run view --log-failed`.'),
      priority: 'urgent', tags: ['ci', tag], status: importStatus(s),
    }))
  }

  async suggest(p, s) {
    const tasks = listTasks(p.path)
    const open = tasks.filter(t => (t.tags || []).includes(SUGGESTED_TAG) && ['backlog', 'todo', 'doing'].includes(t.status))
    const room = s.suggestMax - open.length
    if (room <= 0) return
    const { suggestions } = await analyzeProject(p, [], '', false)
    const titles = new Set(tasks.map(t => t.title.toLowerCase()))
    for (const sug of suggestions.filter(x => !titles.has(x.title.toLowerCase())).slice(0, room)) {
      this.created(p, createTask(p.path, {
        title: sug.title, description: sug.description, priority: sug.priority,
        tags: [sug.type, SUGGESTED_TAG], status: importStatus(s),
      }))
    }
  }

  digest(p, now) {
    const url = webhookUrl(p)
    if (!url) return
    postWebhook(url, {
      event: 'daily_digest', projectId: p.id, project: p.name, at: new Date(now).toISOString(),
      ...buildDigest(listTasks(p.path), now),
    })
  }
}

const importStatus = s => (IMPORT_STATUSES.includes(s.importStatus) ? s.importStatus : 'backlog')

// Data local YYYY-MM-DD (o resumo é "de hoje" no fuso da máquina).
const localDay = now => new Date(now).toLocaleDateString('sv')

export function digestDue(s, st, now) {
  const h = s.digestHour
  if (h == null || h === '' || !(Number(h) >= 0)) return false
  return new Date(now).getHours() >= Number(h) && st.digest !== localDay(now)
}

// Resumo das últimas 24h: o que concluiu, o que travou, o que espera gente e o gasto.
export function buildDigest(tasks, now = Date.now()) {
  const since = now - 86400_000
  const recent = tasks.filter(t => (Date.parse(t.run?.completed_at || '') || 0) >= since)
  const titles = list => list.map(t => ({ id: t.id, title: t.title }))
  const done = recent.filter(t => ['done', 'archived'].includes(t.status))
  const blocked = tasks.filter(t => (t.tags || []).includes('blocked') && t.status !== 'archived')
  const waiting = tasks.filter(t => (t.tags || []).includes('human-request'))
  const costUsd = recent.reduce((sum, t) => sum + (t.run?.cost_usd || 0), 0)
  const line = (label, list) => list.length ? `${label}: ${list.map(t => t.title).join('; ')}` : null
  const text = [
    `${done.length} concluída(s), ${blocked.length} travada(s), ${waiting.length} esperando decisão — US$ ${costUsd.toFixed(2)} nas últimas 24h.`,
    line('Concluídas', done), line('Travadas', blocked), line('Esperando decisão', waiting),
  ].filter(Boolean).join('\n')
  return { done: titles(done), blocked: titles(blocked), waiting: titles(waiting), costUsd, text }
}

// Texto da seção "## Feedback da PR" que o run seguinte lê.
export function prFeedback(t, sum, { ciFailed, commented, conflict, base, cwd }) {
  const parts = [`A PR #${t.run.pr.number} (${t.run.pr.url}) desta task já está aberta na branch ` +
    `\`${t.run.branch || '?'}\`. Atenda o feedback abaixo NESTA branch: corrija, commite e dê push. ` +
    `Não abra outra PR e não comente na PR.`]
  if (ciFailed) {
    parts.push(`### CI falhou (commit ${String(sum.sha).slice(0, 10)})\n\n` + sum.failed.map(c => {
      const log = cwd ? failedRunLog(cwd, c.url) : ''
      return `- ${c.name} — ${c.url}` + (log ? `\n\n\`\`\`\n${log}\n\`\`\`` : '')
    }).join('\n'))
  }
  if (commented) {
    parts.push('### Comentários novos\n\n' + sum.comments.map(c => `- **${c.author || '?'}** (${c.at}): ${c.body.trim()}`).join('\n'))
  }
  if (conflict) parts.push(`### Conflito com ${base}\n\nA PR não mergeia limpo em \`${base}\`: resolva o conflito (instruções no prompt).`)
  return parts.join('\n\n')
}

// Compacta notes.md com o modelo auxiliar quando passa do teto: o prompt só
// carrega a cauda, e sem isso o aprendizado mais antigo some. Quem escreveu
// notas durante a compactação não perde nada — o que chegou depois é mantido.
export function compactNotes(p) {
  const file = notesFile(p.path)
  let original
  try { original = fs.readFileSync(file, 'utf8') } catch { return }
  if (original.length <= NOTES_COMPACT_AT) return
  const prompt = `Abaixo estão notas de aprendizado acumuladas por várias tasks de um projeto.
Reescreva-as num único documento markdown com no máximo 4000 caracteres: junte
duplicatas, descarte o que foi contradito por notas mais novas, mantenha comandos
e armadilhas concretas, agrupe por tema com títulos "### ". Responda SOMENTE com o
documento.

<notas>
${original}
</notas>`
  return new Promise(resolve => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'json', '--model', auxModel(p), '--max-turns', '1'],
      { cwd: p.path, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000)
    child.stdout.on('data', d => { out += d })
    child.on('error', () => { clearTimeout(timer); resolve() })
    child.on('close', code => {
      clearTimeout(timer)
      try {
        const r = JSON.parse(out)
        const text = String(r.result || '').trim()
        if (code !== 0 || r.is_error || !text || text.length >= original.length) return resolve()
        const now = fs.readFileSync(file, 'utf8')
        // Alguém reescreveu o arquivo no meio (edição manual): não pisa.
        if (!now.startsWith(original)) return resolve()
        fs.writeFileSync(file, `${text}\n${now.slice(original.length)}`)
      } catch {}
      resolve()
    })
  })
}
