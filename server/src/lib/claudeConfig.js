import fs from 'node:fs'
import path from 'node:path'

// Arquivos de config do Claude Code que o painel expõe para ver/editar.
// Fonte da verdade é o filesystem do projeto; aqui só descobrimos, lemos e
// gravamos com segurança de path (nada fora do projeto, nada dos dados internos).

const MAX_BYTES = 256 * 1024
const TEXT_EXT = new Set(['.json', '.md', '.mjs', '.js', '.cjs', '.txt', '.toml', '.yaml', '.yml', '.sh'])

// arquivos na raiz do projeto que fazem parte da config do Claude
const ROOT_FILES = ['.mcp.json', 'CLAUDE.md']

// subpastas de .claude que NÃO devem aparecer (dados gerenciados pelo kanban)
const CLAUDE_IGNORE = new Set(['claude-kanban'])

const isTextFile = name => TEXT_EXT.has(path.extname(name).toLowerCase())

// classifica cada arquivo num grupo para a UI agrupar
function categorize(rel) {
  if (rel === '.mcp.json') return 'mcp'
  if (rel.endsWith('.json') && rel.startsWith('.claude/settings')) return 'settings'
  if (rel.includes('/hooks/')) return 'hooks'
  if (rel.includes('/skills/')) return 'skills'
  if (rel.includes('/agents/')) return 'agents'
  if (rel.includes('/commands/')) return 'commands'
  if (rel.includes('/plugins/') || rel.includes('/.claude-plugin/')) return 'plugins'
  return 'outros'
}

function walk(dir, projectPath, out, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const rel = path.relative(projectPath, full)
      if (rel === path.join('.claude', 'claude-kanban')) continue
      if (e.name === 'node_modules') continue
      walk(full, projectPath, out, depth + 1)
    } else if (e.isFile() && isTextFile(e.name)) {
      out.push(path.relative(projectPath, full))
    }
  }
}

// Descobre todos os arquivos de config editáveis. Retorna metadados (sem conteúdo).
export function listConfigFiles(projectPath) {
  const files = []

  for (const f of ROOT_FILES) {
    if (fs.existsSync(path.join(projectPath, f))) files.push(f)
  }

  const claudeDir = path.join(projectPath, '.claude')
  if (fs.existsSync(claudeDir)) {
    try {
      for (const e of fs.readdirSync(claudeDir, { withFileTypes: true })) {
        if (e.isDirectory() && CLAUDE_IGNORE.has(e.name)) continue
        const full = path.join(claudeDir, e.name)
        if (e.isDirectory()) walk(full, projectPath, files)
        else if (e.isFile() && isTextFile(e.name)) files.push(path.relative(projectPath, full))
      }
    } catch {}
  }

  return files.sort().map(rel => {
    let size = 0
    try { size = fs.statSync(path.join(projectPath, rel)).size } catch {}
    return { path: rel, category: categorize(rel), size }
  })
}

// Resolve um relPath pedido pela UI garantindo que fica dentro do escopo permitido.
// Permite: arquivos da raiz na allowlist, ou qualquer caminho sob .claude/
// (menos os dados do kanban). Só extensões de texto.
function resolveSafe(projectPath, relPath) {
  if (typeof relPath !== 'string' || !relPath) throw new Error('caminho inválido')
  if (path.isAbsolute(relPath)) throw new Error('caminho deve ser relativo')
  const norm = path.normalize(relPath).replace(/\\/g, '/')
  if (norm.startsWith('..') || norm.includes('../')) throw new Error('caminho fora do projeto')
  if (!isTextFile(norm)) throw new Error('extensão não editável por aqui')

  const allowed =
    ROOT_FILES.includes(norm) ||
    (norm.startsWith('.claude/') && !norm.startsWith('.claude/claude-kanban/'))
  if (!allowed) throw new Error('arquivo fora do escopo de config')

  const full = path.resolve(projectPath, norm)
  const root = path.resolve(projectPath)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('caminho fora do projeto')
  return full
}

export function readConfigFile(projectPath, relPath) {
  const full = resolveSafe(projectPath, relPath)
  if (!fs.existsSync(full)) return { path: relPath, exists: false, content: '' }
  const stat = fs.statSync(full)
  if (stat.size > MAX_BYTES) throw new Error(`arquivo grande demais para editar (${Math.round(stat.size / 1024)} KB)`)
  return { path: relPath, exists: true, content: fs.readFileSync(full, 'utf8') }
}

export function writeConfigFile(projectPath, relPath, content) {
  const full = resolveSafe(projectPath, relPath)
  if (typeof content !== 'string') throw new Error('conteúdo inválido')
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('conteúdo grande demais')
  // valida JSON antes de gravar, para não quebrar settings.json/.mcp.json
  if (relPath.endsWith('.json')) {
    try { JSON.parse(content) } catch (e) { throw new Error(`JSON inválido: ${e.message}`) }
  }
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return { path: relPath, exists: true, content }
}
