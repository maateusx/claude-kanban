import fs from 'node:fs'
import { diffFile } from '../lib/paths.js'
import { listTasks, findTask, createTask, updateTask, replaceSection } from '../lib/tasks.js'
import { analyzeProject, SUGGESTION_TYPES } from '../lib/analyzer.js'
import { enrichTask } from '../lib/enricher.js'
import { normalizeModel } from '../lib/models.js'
import { parseWhen } from '../lib/scheduler.js'
import { invalidModelMsg, withProject } from './helpers.js'

export default function taskRoutes(app, ctx) {
  const { emit, runner } = ctx
  const noClaude = reply => reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })

  app.get('/api/projects/:projectId/tasks', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return { tasks: listTasks(p.path) }
  })

  app.post('/api/projects/:projectId/tasks', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const { title, description, priority, tags, status, model, enrich, decompose, scheduled_at } = req.body || {}
    if (!title) return reply.code(400).send({ error: 'title é obrigatório' })
    if (model && !normalizeModel(model)) return reply.code(400).send({ error: invalidModelMsg(model) })
    const when = scheduled_at ? parseWhen(scheduled_at) : null
    if (scheduled_at && !when) return reply.code(400).send({ error: 'scheduled_at inválido (use uma data ISO)' })
    const task = createTask(p.path, { title, description, priority, tags, status, model: normalizeModel(model), enrich, decompose, scheduled_at: when })
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
      return await analyzeProject(p, req.body?.types)
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
}
