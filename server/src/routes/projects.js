import fs from 'node:fs'
import { nanoid } from 'nanoid'
import { saveProjects, STATUSES } from '../lib/paths.js'
import { bootstrapProject, uninstallGuardrails } from '../lib/bootstrap.js'
import { DEFAULT_GIT, gitSettings } from '../lib/git.js'
import { normalizeModel } from '../lib/models.js'
import { invalidModelMsg, withProjectRecord, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } from './helpers.js'

function validateProjectPath(projectPath) {
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) return 'diretório não existe'
  try { fs.accessSync(projectPath, fs.constants.W_OK) } catch { return 'diretório não é gravável' }
  return null
}

export default function projectRoutes(app, ctx) {
  const { db, runner, devServers, projectView, bootstrapErrors } = ctx

  app.get('/api/projects', () => ({ projects: db.projects.map(projectView) }))

  app.post('/api/projects', (req, reply) => {
    const { name, path: projectPath, description } = req.body || {}
    if (!name || !projectPath) return reply.code(400).send({ error: 'name e path são obrigatórios' })
    const pathError = validateProjectPath(projectPath)
    if (pathError) return reply.code(400).send({ error: pathError })
    const project = {
      id: nanoid(6), name, path: projectPath,
      description: String(description || '').trim(),
      createdAt: new Date().toISOString(), skipPermissions: false,
    }
    db.projects.push(project)
    saveProjects(db)
    try {
      bootstrapProject(projectPath)
      bootstrapErrors.delete(project.id)
    } catch (e) {
      bootstrapErrors.set(project.id, e.message)
    }
    ctx.startWatcher(project)
    return { project: projectView(project) }
  })

  app.patch('/api/projects/:projectId', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    const { name, description, path: projectPath, skipPermissions, git, defaultModel, autoRun, autoDecompose, devServer, timeoutMs, enrichMode, webhookUrl, webhookStatuses } = req.body || {}
    if (name !== undefined) {
      if (!String(name).trim()) return reply.code(400).send({ error: 'name não pode ser vazio' })
      p.name = String(name).trim()
    }
    if (description !== undefined) p.description = String(description || '').trim()
    if (projectPath !== undefined && projectPath !== p.path) {
      const pathError = validateProjectPath(projectPath)
      if (pathError) return reply.code(400).send({ error: pathError })
      // troca de pasta raiz: para o que aponta para o path antigo e religa no novo
      ctx.stopWatcher(p.id)
      devServers.stop(p.id)
      p.path = projectPath
      try {
        bootstrapProject(p.path)
        bootstrapErrors.delete(p.id)
      } catch (e) {
        bootstrapErrors.set(p.id, e.message)
      }
      ctx.startWatcher(p)
    }
    if (skipPermissions !== undefined) p.skipPermissions = !!skipPermissions
    if (timeoutMs !== undefined) {
      if (timeoutMs === null || timeoutMs === '') {
        p.timeoutMs = null
      } else {
        const ms = Number(timeoutMs)
        if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
          return reply.code(400).send({ error: 'timeoutMs deve estar entre 1 e 240 minutos' })
        }
        p.timeoutMs = Math.round(ms)
      }
    }
    if (defaultModel !== undefined) {
      if (defaultModel && !normalizeModel(defaultModel)) {
        return reply.code(400).send({ error: invalidModelMsg(defaultModel) })
      }
      p.defaultModel = normalizeModel(defaultModel)
    }
    if (enrichMode !== undefined) {
      if (!['off', 'auto', 'always'].includes(enrichMode)) {
        return reply.code(400).send({ error: 'enrichMode deve ser off, auto ou always' })
      }
      p.enrichMode = enrichMode
    }
    if (webhookUrl !== undefined) {
      const u = String(webhookUrl || '').trim()
      if (u && !/^https?:\/\//i.test(u)) {
        return reply.code(400).send({ error: 'webhookUrl deve começar com http:// ou https://' })
      }
      p.webhookUrl = u
    }
    if (webhookStatuses !== undefined) {
      // lista vazia = todos os status (comportamento default), então null/'' desliga o filtro.
      const list = webhookStatuses || []
      if (!Array.isArray(list) || list.some(s => !STATUSES.includes(s))) {
        return reply.code(400).send({ error: `webhookStatuses deve ser um array de status: ${STATUSES.join(', ')}` })
      }
      p.webhookStatuses = list
    }
    if (devServer !== undefined && typeof devServer === 'object') {
      const next = { ...(p.devServer || {}) }
      if (devServer.command !== undefined) next.command = String(devServer.command || '').trim()
      if (devServer.url !== undefined) next.url = String(devServer.url || '').trim()
      p.devServer = next
    }
    if (autoDecompose !== undefined) p.autoDecompose = !!autoDecompose
    if (autoRun !== undefined) {
      p.autoRun = !!autoRun
      if (p.autoRun) ctx.autoEnqueue(p)
    }
    if (git !== undefined && typeof git === 'object') {
      const next = { ...gitSettings(p) }
      if (git.baseBranch !== undefined) next.baseBranch = String(git.baseBranch).trim() || DEFAULT_GIT.baseBranch
      for (const k of ['pullBeforeStart', 'useCurrentBranch', 'commitToNewBranch', 'useWorktree', 'autoPush', 'autoPR', 'autoPRDescription']) {
        if (git[k] !== undefined) next[k] = !!git[k]
      }
      p.git = next
    }
    saveProjects(db)
    return { project: projectView(p) }
  })

  app.post('/api/projects/:projectId/bootstrap', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    try {
      bootstrapProject(p.path)
      bootstrapErrors.delete(p.id)
    } catch (e) {
      bootstrapErrors.set(p.id, e.message)
    }
    return { project: projectView(p) }
  })

  app.delete('/api/projects/:projectId', (req, reply) => {
    const idx = db.projects.findIndex(p => p.id === req.params.projectId)
    if (idx === -1) return reply.code(404).send({ error: 'projeto não encontrado' })
    const [p] = db.projects.splice(idx, 1)
    saveProjects(db)
    runner.dropProject(p.id)
    devServers.stop(p.id)
    ctx.stopWatcher(p.id)
    if (req.query.uninstallGuardrails === 'true' && fs.existsSync(p.path)) {
      uninstallGuardrails(p.path)
    }
    return { ok: true }
  })

  // ---- dev server ----
  app.post('/api/projects/:projectId/dev-server/launch', async (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    try {
      return await devServers.launch(p)
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.post('/api/projects/:projectId/dev-server/stop', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    if (!devServers.stop(p.id)) return reply.code(409).send({ error: 'dev server não está rodando' })
    return devServers.status(p.id)
  })

  app.get('/api/projects/:projectId/dev-server', (req, reply) => {
    const p = withProjectRecord(ctx, req, reply); if (!p) return
    return { ...devServers.status(p.id), logs: devServers.logs(p.id) }
  })
}
