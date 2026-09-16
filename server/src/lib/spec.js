import fs from 'node:fs'
import path from 'node:path'
import { kanbanDir } from './paths.js'

// Especificação do sistema: SPEC.md (módulos, responsabilidades, contratos) e
// adr/NNNN-titulo.md (decisões). Ao contrário do notes.md, é versionada — quem
// escreve são as sessões, no worktree, e ela chega às tasks seguintes pelo git
// (por isso é lida do cwd do run, não do checkout principal).
export const SPEC_REL = '.claude/claude-kanban/spec'
export const DESIGN_TAG = 'desenho'
export const SYSTEM_TAG = 'sistema'
const MAX_SPEC_IN_PROMPT = 6000

export const specDir = root => path.join(kanbanDir(root), 'spec')

// Objetivo grande: desmembrado a partir do nível 0, ou marcado como sistema.
export const needsDesign = (task, level) => level === 0 || (task.tags || []).includes(SYSTEM_TAG)

export function readSpec(root) {
  let spec = ''
  try { spec = fs.readFileSync(path.join(specDir(root), 'SPEC.md'), 'utf8').trim() } catch {}
  let files = []
  try { files = fs.readdirSync(path.join(specDir(root), 'adr')).filter(f => /^\d{4}-.*\.md$/.test(f)).sort() } catch {}
  const adrs = files.map(file => {
    const content = fs.readFileSync(path.join(specDir(root), 'adr', file), 'utf8')
    const title = content.match(/^#\s+(.+)$/m)?.[1].trim() || file.replace(/\.md$/, '')
    return { file, title, content }
  })
  return { spec, adrs }
}

const words = s => new Set((s.toLowerCase().match(/[\p{L}\d]{4,}/gu) || []))

// Resumo (o que vem antes do primeiro "## ") + a seção "## " que mais divide
// palavras com a task. ponytail: relevância por sobreposição de palavras;
// embeddings se isso escolher mal na prática.
export function specExcerpt(spec, text) {
  const [summary, ...rest] = spec.split(/^(?=## )/m)
  const sections = summary.startsWith('## ') ? [summary, ...rest] : rest
  const intro = summary.startsWith('## ') ? '' : summary.trim()
  const wanted = words(text)
  let best = null
  let bestScore = 0
  for (const s of sections) {
    const score = [...words(s)].filter(w => wanted.has(w)).length
    if (score > bestScore) { best = s.trim(); bestScore = score }
  }
  const headings = sections.map(s => s.split('\n')[0].slice(3).trim())
  return { intro, section: best, headings }
}

export function specBlock(root, task) {
  const { spec, adrs } = readSpec(root)
  const design = (task.tags || []).includes(DESIGN_TAG)
  if (!spec && !adrs.length) {
    return design ? `
Este projeto ainda não tem especificação. Crie ${SPEC_REL}/SPEC.md (resumo do
sistema no topo e uma seção "## " por módulo: responsabilidades e contratos) e
registre as decisões de arquitetura em ${SPEC_REL}/adr/0001-titulo.md.
` : ''
  }
  const { intro, section, headings } = specExcerpt(spec, `${task.title}\n${task.body || ''}`)
  let body = [
    intro,
    section && `(seção mais relevante para esta task)\n\n${section}`,
    headings.length && `Seções da spec: ${headings.join(' · ')}`,
    adrs.length && `ADRs:\n${adrs.map(a => `- ${a.file}: ${a.title}`).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  if (body.length > MAX_SPEC_IN_PROMPT) body = body.slice(0, MAX_SPEC_IN_PROMPT) + '\n[…]'
  return `
Especificação do sistema (${SPEC_REL}/ — fonte da verdade do projeto). Siga os
contratos e as decisões registradas; leia o arquivo inteiro ou um ADR se precisar.
${design ? 'Esta é a task de DESENHO: atualize a spec e os ADRs para o objetivo antes de qualquer código.\n' : 'Se sua mudança alterar um contrato, atualize a spec no mesmo commit.\n'}
<spec>
${body}
</spec>
`
}
