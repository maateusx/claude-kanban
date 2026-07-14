import { projectBranch, listBranches, checkoutBranch, fetchRemotes, isDirty } from '../lib/git.js'
import { withProject } from './helpers.js'

export default function gitRoutes(app, ctx) {
  const { emit, projectView } = ctx

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
}
