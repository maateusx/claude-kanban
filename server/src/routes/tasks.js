import fs from 'node:fs'
import { diffFile, STATUSES } from '../lib/paths.js'
import {
  listTasks, findTask, createTask, updateTask, deleteTask, replaceSection,
  normalizeDependsOn, hasDependencyCycle,
} from '../lib/tasks.js'
import { analyzeProject, SUGGESTION_TYPES } from '../lib/analyzer.js'
import { enrichTask } from '../lib/enricher.js'
import { listTemplates, findTemplate } from '../lib/templates.js'
import { listIssues, issueTag, issueDescription } from '../lib/github.js'
import { computeStats } from '../lib/stats.js'
import { normalizeModel } from '../lib/models.js'
import { parseWhen } from '../lib/scheduler.js'
import { invalidModelMsg, withProject, PRIORITIES } from './helpers.js'
import { readSpec } from '../lib/spec.js'

// Valida depends_on: ids precisam existir no projeto, nada de auto-dependência e
// nada de ciclo (A→B→A trava a fila para sempre). taskId é o id da própria task
// (num POST ainda não existe: usamos um sentinel que nunca colide com um id real).
function validateDeps(projectPath, taskId, value) {
  const deps = normalizeDependsOn(value)
  if (!deps.length) return { deps }
  const known = new Set(listTasks(projectPath).map(t => t.id))
  const missing = deps.filter(id => !known.has(id))
  if (missing.length) return { error: `depends_on referencia task inexistente: ${missing.join(', ')}` }
  if (deps.includes(taskId)) return { error: 'depends_on não pode referenciar a própria task' }
  if (hasDependencyCycle(listTasks(projectPath), taskId, deps)) {
    return { error: 'depends_on cria um ciclo de dependências' }
  }
  return { deps }
}

export default function taskRoutes(app, ctx) {
  const { emit, runner } = ctx
  const noClaude = reply => reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })

  app.get('/api/projects/:projectId/tasks', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return { tasks: listTasks(p.path) }
  })

  app.get('/api/projects/:projectId/templates', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return { templates: listTemplates(p.path) }
  })

  // Spec e ADRs do projeto (somente leitura), do checkout principal: o que já foi mergeado.
  app.get('/api/projects/:projectId/spec', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return readSpec(p.path)
  })

  // Custos/histórico: agrega os blocos `run` dos .md por dia/modelo/status.
  // ?days=0 (ou ausente de janela) = período inteiro.
  app.get('/api/projects/:projectId/stats', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const days = req.query.days === undefined ? 30 : Number(req.query.days)
    if (!Number.isFinite(days) || days < 0) return reply.code(400).send({ error: 'days inválido' })
    return computeStats(listTasks(p.path), { days, defaultModel: p.defaultModel || null })
  })

  app.post('/api/projects/:projectId/tasks', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const { title, description, priority, tags, status, model, enrich, decompose, scheduled_at, template, depends_on } = req.body || {}
    if (!title) return reply.code(400).send({ error: 'title é obrigatório' })
    if (model && !normalizeModel(model)) return reply.code(400).send({ error: invalidModelMsg(model) })
    if (template && !findTemplate(p.path, template)) return reply.code(400).send({ error: `template não encontrado: ${template}` })
    const when = scheduled_at ? parseWhen(scheduled_at) : null
    if (scheduled_at && !when) return reply.code(400).send({ error: 'scheduled_at inválido (use uma data ISO)' })
    const { deps, error } = validateDeps(p.path, '__new__', depends_on)
    if (error) return reply.code(400).send({ error })
    const task = createTask(p.path, { title, description, priority, tags, status, model: normalizeModel(model), enrich, decompose, scheduled_at: when, depends_on: deps, template })
    emit('task.upserted', { projectId: p.id, task })
    return { task }
  })

  app.get('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const task = findTask(p.path, req.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task não encontrada' })
    return { task }
  })

  app.patch('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const before = findTask(p.path, req.params.taskId)
    if (!before) return reply.code(404).send({ error: 'task não encontrada' })
    const patch = { ...(req.body || {}) }
    if (patch.model !== undefined) {
      if (patch.model && !normalizeModel(patch.model)) {
        return reply.code(400).send({ error: invalidModelMsg(patch.model) })
      }
      patch.model = normalizeModel(patch.model)
    }
    // scheduled_at: '' / null desagenda; qualquer outra coisa precisa ser uma data.
    if (patch.scheduled_at !== undefined) {
      if (!patch.scheduled_at) {
        patch.scheduled_at = null
      } else {
        const iso = parseWhen(patch.scheduled_at)
        if (!iso) return reply.code(400).send({ error: 'scheduled_at inválido (use uma data ISO)' })
        patch.scheduled_at = iso
      }
    }
    if (patch.depends_on !== undefined) {
      const { deps, error } = validateDeps(p.path, req.params.taskId, patch.depends_on)
      if (error) return reply.code(400).send({ error })
      patch.depends_on = deps
    }
    const task = updateTask(p.path, req.params.taskId, patch)
    if (before.status !== task.status) {
      emit('task.moved', { projectId: p.id, taskId: task.id, from: before.status, to: task.status })
    }
    emit('task.upserted', { projectId: p.id, task })
    return { task }
  })

  app.delete('/api/projects/:projectId/tasks/:taskId', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const before = findTask(p.path, req.params.taskId)
    if (!before) return reply.code(404).send({ error: 'task não encontrada' })
    if (req.query.hard === 'true') {
      deleteTask(p.path, req.params.taskId)
      emit('task.removed', { projectId: p.id, taskId: req.params.taskId })
      return { ok: true }
    }
    const task = updateTask(p.path, req.params.taskId, { status: 'archived' })
    emit('task.moved', { projectId: p.id, taskId: task.id, from: before.status, to: 'archived' })
    emit('task.upserted', { projectId: p.id, task })
    return { task }
  })

  app.get('/api/projects/:projectId/tasks/:taskId/diff', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const task = findTask(p.path, req.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task não encontrada' })
    const file = diffFile(p.path, task.id)
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'nenhum diff registrado para esta task' })
    return { diff: fs.readFileSync(file, 'utf8') }
  })

  app.get('/api/projects/:projectId/tasks/:taskId/log', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const task = findTask(p.path, req.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task não encontrada' })
    const events = runner.readLog(p.path, task.id)
    return { events: events || [] }
  })

  // ---- análise do projeto (sugestão de tasks) ----
  app.get('/api/suggestion-types', () => ({ types: SUGGESTION_TYPES }))

  app.post('/api/projects/:projectId/analyze', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return noClaude(reply)
    try {
      return await analyzeProject(p, req.body?.types, req.body?.question, req.body?.report)
    } catch (e) {
      return reply.code(500).send({ error: e.message })
    }
  })

  // ---- enriquecer/reescrever a descrição de uma task (sob demanda) ----
  app.post('/api/projects/:projectId/tasks/:taskId/enrich', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return noClaude(reply)
    const task = findTask(p.path, req.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task não encontrada' })
    if (runner.getQueueView().actives.some(a => a.taskId === task.id)) {
      return reply.code(409).send({ error: 'task está em execução — aguarde terminar' })
    }
    try {
      const res = await enrichTask(p, task, { auto: !!req.body?.auto })
      let updated = task
      if (res.enrich) {
        updated = updateTask(p.path, task.id, {
          ...(res.title ? { title: res.title } : {}),
          body: replaceSection(task.body, 'Descrição', res.description),
        })
        emit('task.upserted', { projectId: p.id, task: updated })
      }
      return { enriched: res.enrich, reason: res.reason, costUsd: res.costUsd, task: updated }
    } catch (e) {
      return reply.code(500).send({ error: e.message })
    }
  })

  // ---- importar issues do GitHub como tasks ----
  // Toda task importada leva a tag `gh:<n>`: é ela (e não o título) que identifica a
  // issue de origem, então reimportar a mesma issue não duplica card.
  app.get('/api/projects/:projectId/issues', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    let issues
    try {
      issues = listIssues(p.path, { state: req.query.state === 'all' ? 'all' : 'open' })
    } catch (e) {
      return reply.code(e.code ? 409 : 500).send({ error: e.message })
    }
    const imported = new Set(listTasks(p.path).flatMap(t => (t.tags || []).filter(tag => tag.startsWith('gh:'))))
    return { issues: issues.map(i => ({ ...i, imported: imported.has(issueTag(i.number)) })) }
  })

  app.post('/api/projects/:projectId/issues/import', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const numbers = [...new Set((req.body?.numbers || []).map(Number).filter(Number.isInteger))]
    if (!numbers.length) return reply.code(400).send({ error: 'numbers é obrigatório (issues a importar)' })
    const { priority, status } = req.body || {}

    let issues
    try {
      issues = listIssues(p.path, { state: 'all' })
    } catch (e) {
      return reply.code(e.code ? 409 : 500).send({ error: e.message })
    }
    const byNumber = new Map(issues.map(i => [i.number, i]))
    const existing = new Set(listTasks(p.path).flatMap(t => t.tags || []))

    const created = []
    const skipped = []
    for (const n of numbers) {
      const issue = byNumber.get(n)
      if (!issue) { skipped.push({ number: n, reason: 'issue não encontrada' }); continue }
      if (existing.has(issueTag(n))) { skipped.push({ number: n, reason: 'já importada' }); continue }
      const task = createTask(p.path, {
        title: issue.title,
        description: issueDescription(issue),
        priority: PRIORITIES.includes(priority) ? priority : 'medium',
        tags: ['issue', issueTag(n)],
        status: STATUSES.includes(status) ? status : 'backlog',
      })
      existing.add(issueTag(n))
      created.push(task)
      emit('task.upserted', { projectId: p.id, task })
    }
    return { created, skipped }
  })
}
