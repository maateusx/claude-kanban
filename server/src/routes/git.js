import fs from 'node:fs'
import { projectBranch, listBranches, checkoutBranch, fetchRemotes, isDirty, mergeTaskBranch, deleteTaskBranch } from '../lib/git.js'
import { findTask, updateTask } from '../lib/tasks.js'
import { diffFile } from '../lib/paths.js'
import { withProject } from './helpers.js'

export default function gitRoutes(app, ctx) {
  const { emit, projectView, runner } = ctx

  // Aprovar/descartar o resultado de uma task pelo diff. São ações explícitas do
  // humano: o merge em `main` é justamente o que o guard.mjs bloqueia para o agente.
  const busyWithTask = taskId =>
    runner.actives.has(taskId) || runner.queue.some(q => q.taskId === taskId)

  const taskWithBranch = (req, reply, p) => {
    const task = findTask(p.path, req.params.taskId)
    if (!task) { reply.code(404).send({ error: 'task não encontrada' }); return null }
    if (busyWithTask(task.id)) { reply.code(409).send({ error: 'task em execução ou na fila — pare antes' }); return null }
    const branch = task.run?.branch
    if (!branch) { reply.code(409).send({ error: 'a task não tem branch registrada' }); return null }
    return { task, branch }
  }

  const withTag = (task, tag) => [...new Set([...(task.tags || []), tag])]

  app.get('/api/projects/:projectId/branches', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    let fetchError = null
    if (req.query.fetch === 'true') {
      try { fetchRemotes(p.path) } catch (e) { fetchError = e.message }
    }
    return { branch: projectBranch(p.path), branches: listBranches(p.path), fetchError }
  })

  app.post('/api/projects/:projectId/branch', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const name = (req.body?.branch || '').trim()
    if (!name) return reply.code(400).send({ error: 'branch obrigatória' })
    const stash = !!req.body?.stash
    try {
      const res = checkoutBranch(p.path, name, { stash })
      emit('project.updated', { projectId: p.id })
      return { ...res, project: projectView(p) }
    } catch (e) {
      // canStash: o checkout falhou e há mudanças que um stash resolveria — a UI
      // oferece "guardar e trocar". Se o stash já foi tentado, não reoferece.
      return reply.code(409).send({ error: e.message, canStash: !stash && isDirty(p.path) })
    }
  })

  app.post('/api/projects/:projectId/tasks/:taskId/approve', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const found = taskWithBranch(req, reply, p); if (!found) return
    const { task, branch } = found
    let result
    try {
      result = mergeTaskBranch(p, branch)
    } catch (e) {
      return reply.code(409).send({ error: e.message, conflict: !!e.conflict })
    }
    const archive = req.body?.archive !== false
    const updated = updateTask(p.path, task.id, {
      tags: withTag(task, 'merged'),
      status: archive ? 'archived' : 'done',
    })
    if (updated.status !== task.status) {
      emit('task.moved', { projectId: p.id, taskId: task.id, from: task.status, to: updated.status })
    }
    emit('task.upserted', { projectId: p.id, task: updated })
    emit('project.updated', { projectId: p.id })
    return { task: updated, ...result }
  })

  app.post('/api/projects/:projectId/tasks/:taskId/discard', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const found = taskWithBranch(req, reply, p); if (!found) return
    const { task, branch } = found
    let deleted
    try {
      deleted = deleteTaskBranch(p, branch).deleted
    } catch (e) {
      return reply.code(409).send({ error: e.message })
    }
    try { fs.rmSync(diffFile(p.path, task.id), { force: true }) } catch {}
    const updated = updateTask(p.path, task.id, {
      tags: withTag(task, 'discarded'),
      run: { has_diff: false, branch: null },
    })
    emit('task.upserted', { projectId: p.id, task: updated })
    emit('project.updated', { projectId: p.id })
    return { task: updated, branch, deleted }
  })
}
