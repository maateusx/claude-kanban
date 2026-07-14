import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { templatesDir } from './paths.js'

// Seções que o runner/backend escrevem: um template nunca as substitui, e elas
// são recriadas no fim do corpo se o autor do template não as declarou.
export const RESERVED_SECTIONS = ['Resultado', 'Log de erros']

const SECTION_STUBS = {
  'Resultado': '<!-- Preenchido pelo Claude ao concluir: resumo, decisões, arquivos alterados, contexto para memória -->',
  'Log de erros': '<!-- Preenchido pelo backend em caso de falha -->',
}

function hasSection(body, header) {
  return new RegExp(`^##\\s+${header}\\s*$`, 'im').test(body || '')
}

function parseTemplate(filePath) {
  const { data, content } = matter(fs.readFileSync(filePath, 'utf8'))
  const id = path.basename(filePath, '.md')
  return {
    id,
    title: data.title || id,
    description: data.description || '',
    priority: data.priority || null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    model: data.model || null,
    body: content.trim(),
  }
}

export function listTemplates(projectPath) {
  const dir = templatesDir(projectPath)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue
    try { out.push(parseTemplate(path.join(dir, f))) } catch { /* template corrompido: ignora */ }
  }
  return out
}

export function findTemplate(projectPath, id) {
  if (!id) return null
  // O id vem do cliente e vira nome de arquivo: barra/".." sairiam da pasta.
  if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) return null
  const file = path.join(templatesDir(projectPath), `${id}.md`)
  if (!fs.existsSync(file)) return null
  try { return parseTemplate(file) } catch { return null }
}

// Monta o corpo da task a partir do template: a descrição digitada pelo humano
// substitui a seção "## Descrição" do template (o resto das seções é preservado)
// e as seções reservadas são garantidas no fim.
export function bodyFromTemplate(template, description = '') {
  let body = template.body
  if (description) {
    body = hasSection(body, 'Descrição')
      ? replaceSectionBody(body, 'Descrição', description)
      : `## Descrição\n\n${description}\n\n${body}`
  }
  for (const h of RESERVED_SECTIONS) {
    if (!hasSection(body, h)) body += `\n\n## ${h}\n${SECTION_STUBS[h]}`
  }
  return `\n${body.trim()}\n`
}

// Igual ao replaceSection de tasks.js, mas local para evitar dependência circular.
function replaceSectionBody(body, header, text) {
  const m = new RegExp(`^##\\s+${header}\\s*$`, 'im').exec(body)
  const rest = body.slice(m.index + m[0].length)
  const next = /^##\s+/m.exec(rest)
  const tail = next ? rest.slice(next.index) : ''
  return `${body.slice(0, m.index)}## ${header}\n\n${text}\n\n${tail}`
}
