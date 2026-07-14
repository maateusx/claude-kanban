import { saveProjects } from '../lib/paths.js'
import { findTask, updateTask, replaceSection } from '../lib/tasks.js'
import { parseWhen, isFuture } from '../lib/scheduler.js'
import { withProject, withProjectRecord } from './helpers.js'

export default function runRoutes(app, ctx) {
  const { db, runner, emit, projectView, getProject } = ctx
  const noClaude = reply => reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })

  app.post('/api/projects/:projectId/tasks/:taskId/run', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return noClaude(reply)
    const ok = runner.enqueue(p.id, req.params.taskId)
    if (!ok) return reply.code(409).send({ error: 'task já está na fila ou não existe' })
    return runner.getQueueView()
  })

  app.post('/api/projects/:projectId/tasks/:taskId/human-response', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return noClaude(reply)
    const task = findTask(p.path, req.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task não encontrada' })
    const response = String(req.body?.response ?? '').trim()
    if (!response) return reply.code(400).send({ error: 'response é obrigatório' })
    const view = runner.getQueueView()
    if (view.actives.some(a => a.taskId === task.id) || view.queue.some(q => q.taskId === task.id)) {
      return reply.code(409).send({ error: 'task já está na fila ou em execução — aguarde terminar' })
    }
    updateTask(p.path, task.id, { body: replaceSection(task.body, 'Human Response', response) })
    // enqueue (auto: false) remove a tag human-request e devolve a task para a fila.
    runner.enqueue(p.id, task.id)
    const updated = findTask(p.path, task.id)
    emit('task.upserted', { projectId: p.id, task: updated })
    return { task: updated, queue: runner.getQueueView() }
  })

  // Desmembrar agora: roda a sessão de decomposição imediatamente (fora da fila).
  app.post('/api/projects/:projectId/tasks/:taskId/decompose', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return noClaude(reply)
    const ok = runner.decomposeNow(p.id, req.params.taskId)
    if (!ok) return reply.code(409).send({ error: 'task já está na fila/rodando ou não existe' })
    return runner.getQueueView()
  })

  app.post('/api/run/kill', (req, reply) => {
    if (!runner.kill(req.body?.taskId)) {
      return reply.code(409).send({ error: 'nenhuma sessão ativa correspondente (com mais de uma ativa, informe taskId)' })
    }
    return { ok: true }
  })

  // Cancela uma task que está esperando na fila (ainda não começou a rodar).
  // Com autoRun ligado, tudo que está em todo/ volta para a fila sozinho — então
  // cancelar de verdade significa devolver o card para backlog/. Sem autoRun, o
  // card fica em todo/ mesmo, e sair da fila já basta.
  app.post('/api/run/dequeue', (req, reply) => {
    const taskId = req.body?.taskId
    const removed = taskId ? runner.dequeue(taskId) : null
    if (!removed) return reply.code(409).send({ error: 'task não está na fila (se já está rodando, use matar sessão)' })

    const p = getProject(removed.projectId)
    const task = p && findTask(p.path, taskId)
    if (p?.autoRun && task?.status === 'todo') {
      emit('task.upserted', { projectId: p.id, task: updateTask(p.path, taskId, { status: 'backlog' }) })
    }
    return runner.getQueueView()
  })

  // ---- agendamento da fila (adiar tudo de um projeto para X) ----
  app.post('/api/projects/:projectId/queue/pause', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    const until = parseWhen(req.body?.until)
    if (!until) return reply.code(400).send({ error: 'until inválido (use uma data ISO)' })
    if (!isFuture(until)) return reply.code(400).send({ error: 'until precisa estar no futuro' })
    p.queuePausedUntil = until
    saveProjects(db)
    emit('project.updated', { projectId: p.id })
    return { project: projectView(p) }
  })

  app.post('/api/projects/:projectId/queue/resume', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    p.queuePausedUntil = null
    saveProjects(db)
    emit('project.updated', { projectId: p.id })
    runner.tick()
    return { project: projectView(p) }
  })

  // ---- pausa global da fila (todos os projetos) ----
  // Sempre em modo "drenar": nada novo sai da fila, mas as sessões já ativas
  // terminam normalmente. Sem `until` a pausa é indefinida (até o resume).
  app.post('/api/run/pause', (req, reply) => {
    const raw = req.body?.until
    let until = null
    if (raw) {
      until = parseWhen(raw)
      if (!until) return reply.code(400).send({ error: 'until inválido (use uma data ISO)' })
      if (!isFuture(until)) return reply.code(400).send({ error: 'until precisa estar no futuro' })
    }
    return runner.pause(until)
  })

  app.post('/api/run/resume', () => runner.resume())

  app.post('/api/run/concurrency', req => {
    runner.setConcurrency(req.body?.max)
    return runner.getQueueView()
  })

  app.get('/api/run/queue', () => runner.getQueueView())

  app.post('/api/run/queue/reorder', req => {
    runner.reorder(req.body?.taskIds || [])
    return runner.getQueueView()
  })
}
