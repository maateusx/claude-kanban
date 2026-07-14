import { execFileSync } from 'node:child_process'

const TIMEOUT_MS = 30_000
const MAX_ISSUES = 100

export const GH_MISSING = 'CLI `gh` não encontrado no PATH — instale o GitHub CLI (https://cli.github.com) e rode `gh auth login`'

// Erro com `code` para a rota traduzir em status HTTP (409 = ambiente não pronto).
class GhError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

export function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: TIMEOUT_MS })
    return true
  } catch { return false }
}

function gh(cwd, args) {
  try {
    return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS })
  } catch (e) {
    if (e.code === 'ENOENT') throw new GhError(GH_MISSING, 'gh_missing')
    const detail = String(e.stderr || e.message || '').trim()
    // gh distingue mal os casos no exit code; a mensagem é o que sobra.
    if (/not logged|authentication|gh auth login/i.test(detail)) {
      throw new GhError('`gh` não está autenticado — rode `gh auth login`', 'gh_auth')
    }
    if (/not a git repository|could not determine|no git remote|none of the git remotes/i.test(detail)) {
      throw new GhError('projeto não está ligado a um repositório do GitHub (sem remote reconhecido pelo `gh`)', 'gh_no_repo')
    }
    throw new GhError(`gh ${args.join(' ')}: ${detail.slice(-500) || 'falhou'}`, 'gh_failed')
  }
}

// Tag que amarra a task à issue de origem — é ela que garante o dedupe.
export const issueTag = number => `gh:${number}`

export function listIssues(projectPath, { state = 'open', limit = MAX_ISSUES } = {}) {
  const out = gh(projectPath, [
    'issue', 'list',
    '--json', 'number,title,body,labels,url',
    '--state', state,
    '--limit', String(Math.min(Number(limit) || MAX_ISSUES, MAX_ISSUES)),
  ])
  let parsed
  try { parsed = JSON.parse(out) } catch {
    throw new GhError('não consegui interpretar a resposta do `gh issue list`', 'gh_failed')
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(i => Number.isInteger(i?.number))
    .map(i => ({
      number: i.number,
      title: String(i.title || `Issue #${i.number}`).trim().slice(0, 200),
      body: typeof i.body === 'string' ? i.body.trim() : '',
      url: typeof i.url === 'string' ? i.url : '',
      labels: (Array.isArray(i.labels) ? i.labels : []).map(l => String(l?.name || l)).filter(Boolean),
    }))
}

// Descrição da task importada: corpo da issue + a referência, para o Claude citar
// a issue no `## Resultado` (e para o humano abrir com um clique).
export function issueDescription(issue) {
  const body = issue.body || '_(issue sem corpo)_'
  const ref = issue.url ? `[#${issue.number}](${issue.url})` : `#${issue.number}`
  return `${body}\n\nImportada da issue ${ref} do GitHub: **${issue.title}**.\nCite a issue \`#${issue.number}\` no \`## Resultado\` ao concluir.`
}

export { GhError }
