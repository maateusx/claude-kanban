import fs from 'node:fs'
import { listModels } from '../lib/models.js'

export const MIN_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 240 * 60_000
export const PRIORITIES = ['low', 'medium', 'high', 'urgent']

export const invalidModelMsg = (v) => `modelo inválido: "${v}". Use um destes: ${listModels().map(m => m.id).join(', ')}`

// Resolve o projeto da rota; responde 404/409 e devolve null quando não dá para seguir.
export function withProject(ctx, req, reply) {
  const p = ctx.getProject(req.params.projectId)
  if (!p) { reply.code(404).send({ error: 'projeto não encontrado' }); return null }
  if (!fs.existsSync(p.path)) { reply.code(409).send({ error: 'diretório do projeto indisponível' }); return null }
  return p
}

// Mesma coisa, mas sem exigir que o diretório exista (rotas que só mexem no db).
export function withProjectRecord(ctx, req, reply) {
  const p = ctx.getProject(req.params.projectId)
  if (!p) { reply.code(404).send({ error: 'projeto não encontrado' }); return null }
  return p
}
