import { listPendingActions, resolvePendingAction, runPendingAction } from '../lib/pending.js'
import { listConfigFiles, readConfigFile, writeConfigFile } from '../lib/claudeConfig.js'
import { withProject } from './helpers.js'

export default function configRoutes(app, ctx) {
  const { emit } = ctx

  // ---- pending actions ----
  app.get('/api/projects/:projectId/pending-actions', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return { actions: listPendingActions(p.path) }
  })

  app.post('/api/projects/:projectId/pending-actions/:actionId/resolve', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const ok = resolvePendingAction(p.path, req.params.actionId)
    if (!ok) return reply.code(404).send({ error: 'ação não encontrada ou já resolvida' })
    const actions = listPendingActions(p.path)
    emit('pending.updated', { projectId: p.id, actions })
    return { actions }
  })

  app.post('/api/projects/:projectId/pending-actions/:actionId/run', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    const res = await runPendingAction(p.path, req.params.actionId)
    if (!res) return reply.code(404).send({ error: 'ação não encontrada' })
    return res
  })

  // ---- claude config (settings, mcp, hooks, skills, agents, commands…) ----
  app.get('/api/projects/:projectId/claude-config', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    return { files: listConfigFiles(p.path) }
  })

  app.get('/api/projects/:projectId/claude-config/file', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    try { return readConfigFile(p.path, req.query.path) }
    catch (e) { return reply.code(400).send({ error: e.message }) }
  })

  app.put('/api/projects/:projectId/claude-config/file', (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    try {
      const res = writeConfigFile(p.path, req.body?.path, req.body?.content)
      emit('project.updated', { projectId: p.id })
      return res
    } catch (e) { return reply.code(400).send({ error: e.message }) }
  })
}
