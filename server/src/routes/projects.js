import fs from 'node:fs'
import { nanoid } from 'nanoid'
import { saveProjects, STATUSES } from '../lib/paths.js'
import { bootstrapProject, uninstallGuardrails } from '../lib/bootstrap.js'
import { DEFAULT_GIT, gitSettings } from '../lib/git.js'
import { normalizeModel } from '../lib/models.js'
import { retrySettings, MAX_MAX_TURNS, RAW_MODES } from '../lib/runner.js'
import { pluginsView, syncProjectPlugins, normalizeKeys, PLUGIN_KEYS } from '../lib/plugins.js'
import { invalidModelMsg, withProject, withProjectRecord, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } from './helpers.js'

function validateProjectPath(projectPath, create = false) {
  // create: projeto novo (greenfield) — quem chama pela API não tem como dar mkdir.
  if (create && !fs.existsSync(projectPath)) {
    try { fs.mkdirSync(projectPath, { recursive: true }) }
    catch (e) { return `não consegui criar o diretório: ${e.message}` }
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) return 'diretório não existe'
  try { fs.accessSync(projectPath, fs.constants.W_OK) } catch { return 'diretório não é gravável' }
  return null
}

export default function projectRoutes(app, ctx) {
  const { db, runner, devServers, projectView, bootstrapErrors } = ctx

  app.get('/api/projects', () => ({ projects: db.projects.map(projectView) }))

  // Ordem do rail. Mesma semântica de runner.reorder: ids recebidos primeiro,
  // na ordem dada; o que não veio (ou id desconhecido) mantém a posição relativa no fim.
  app.post('/api/projects/reorder', (req, reply) => {
    const ids = req.body?.projectIds
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'projectIds deve ser um array' })
    const byId = new Map(db.projects.map(p => [p.id, p]))
    const next = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean)
    for (const p of db.projects) if (!next.includes(p)) next.push(p)
    db.projects.splice(0, db.projects.length, ...next)
    saveProjects(db)
    return { projects: db.projects.map(projectView) }
  })

  app.post('/api/projects', (req, reply) => {
    const { name, path: projectPath, description, create } = req.body || {}
    if (!name || !projectPath) return reply.code(400).send({ error: 'name e path são obrigatórios' })
    const pathError = validateProjectPath(projectPath, !!create)
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
    const { name, description, path: projectPath, skipPermissions, git, defaultModel, auxModel: auxModelIn,
      autoRun, autoDecompose, autoDecide, reviewGate, goalBudgetUsd, devServer, timeoutMs, enrichMode, rawMode, retry, maxTurns,
      webhookUrl, webhookStatuses } = req.body || {}
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
    if (maxTurns !== undefined) {
      if (maxTurns === null || maxTurns === '') {
        p.maxTurns = null
      } else {
        const n = Number(maxTurns)
        // 0 desliga o teto (comportamento antigo: só o timeout limita a sessão).
        if (!Number.isInteger(n) || n < 0 || n > MAX_MAX_TURNS) {
          return reply.code(400).send({ error: `maxTurns deve ser 0 (sem limite) ou um inteiro até ${MAX_MAX_TURNS}` })
        }
        p.maxTurns = n
      }
    }
    if (retry !== undefined && typeof retry === 'object') {
      const next = { ...(p.retry || {}) }
      if (retry.maxAttempts !== undefined) {
        const n = Number(retry.maxAttempts)
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          return reply.code(400).send({ error: 'retry.maxAttempts deve ser um inteiro entre 1 e 10' })
        }
        next.maxAttempts = n
      }
      if (retry.backoffMinutes !== undefined) {
        const n = Number(retry.backoffMinutes)
        if (!Number.isFinite(n) || n < 0 || n > 1440) {
          return reply.code(400).send({ error: 'retry.backoffMinutes deve estar entre 0 e 1440' })
        }
        next.backoffMinutes = n
      }
      p.retry = next
    }
    if (defaultModel !== undefined) {
      if (defaultModel && !normalizeModel(defaultModel)) {
        return reply.code(400).send({ error: invalidModelMsg(defaultModel) })
      }
      p.defaultModel = normalizeModel(defaultModel)
    }
    if (auxModelIn !== undefined) {
      if (auxModelIn && !normalizeModel(auxModelIn)) {
        return reply.code(400).send({ error: invalidModelMsg(auxModelIn) })
      }
      p.auxModel = normalizeModel(auxModelIn)
    }
    if (maxTurns !== undefined) {
      if (maxTurns === null || maxTurns === '') {
        p.maxTurns = null
      } else {
        const n = Number(maxTurns)
        // 0 desliga o teto (comportamento antigo, sem limite de turnos).
        if (!Number.isInteger(n) || n < 0 || n > MAX_MAX_TURNS) {
          return reply.code(400).send({ error: `maxTurns deve ser 0 (sem limite) ou um inteiro até ${MAX_MAX_TURNS}` })
        }
        p.maxTurns = n
      }
    }
    if (retry !== undefined && typeof retry === 'object' && retry !== null) {
      const next = { ...retrySettings(p) }
      if (retry.maxAttempts !== undefined) {
        const n = Number(retry.maxAttempts)
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          return reply.code(400).send({ error: 'retry.maxAttempts deve ser um inteiro entre 1 e 10' })
        }
        next.maxAttempts = n
      }
      if (retry.backoffMinutes !== undefined) {
        const n = Number(retry.backoffMinutes)
        if (!Number.isFinite(n) || n < 0 || n > 1440) {
          return reply.code(400).send({ error: 'retry.backoffMinutes deve estar entre 0 e 1440' })
        }
        next.backoffMinutes = n
      }
      p.retry = next
    }
    if (enrichMode !== undefined) {
      if (!['off', 'auto', 'always'].includes(enrichMode)) {
        return reply.code(400).send({ error: 'enrichMode deve ser off, auto ou always' })
      }
      p.enrichMode = enrichMode
    }
    if (rawMode !== undefined) {
      if (rawMode !== 'off' && !RAW_MODES.includes(rawMode)) {
        return reply.code(400).send({ error: `rawMode deve ser off, ${RAW_MODES.join(', ')}` })
      }
      p.rawMode = rawMode
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
    if (autoDecide !== undefined) p.autoDecide = !!autoDecide
    if (reviewGate !== undefined) p.reviewGate = !!reviewGate
    if (goalBudgetUsd !== undefined) {
      const n = goalBudgetUsd === null || goalBudgetUsd === '' ? null : Number(goalBudgetUsd)
      if (n !== null && (!Number.isFinite(n) || n < 0)) {
        return reply.code(400).send({ error: 'goalBudgetUsd deve ser um valor em dólares >= 0 (vazio desliga)' })
      }
      p.goalBudgetUsd = n || null
    }
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

  // ---- plugins de Claude Code ----
  // Ficam fora do PATCH porque não são só config: salvar dispara download e
  // instalação de repositórios de terceiros, que demora e pode falhar por
  // plugin. O PATCH precisa continuar barato e sem efeito de rede.
  app.get('/api/projects/:projectId/plugins', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })
    return await pluginsView(p)
  })

  app.put('/api/projects/:projectId/plugins', async (req, reply) => {
    const p = withProject(ctx, req, reply); if (!p) return
    if (!ctx.claudeAvailable()) return reply.code(409).send({ error: 'CLI `claude` não encontrado no PATH' })

    const requested = req.body?.enabled
    if (!Array.isArray(requested)) return reply.code(400).send({ error: 'enabled é obrigatório (array)' })
    const unknown = requested.filter(k => !PLUGIN_KEYS.includes(k))
    if (unknown.length) {
      return reply.code(400).send({ error: `plugin desconhecido: ${unknown.join(', ')}. Use: ${PLUGIN_KEYS.join(', ')}` })
    }

    const wanted = normalizeKeys(requested)
    const result = await syncProjectPlugins(p.path, wanted)
    // Só entra na config o que de fato instalou. Gravar a intenção faria a UI
    // mostrar um plugin ligado que não existe na máquina.
    p.plugins = wanted.filter(k => !result.errors.some(e => e.key === k))
    saveProjects(db)
    return { ...(await pluginsView(p)), ...result, project: projectView(p) }
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
