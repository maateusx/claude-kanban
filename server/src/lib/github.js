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

export function listIssues(projectPath, { state = 'open', limit = MAX_ISSUES, label = '' } = {}) {
  const out = gh(projectPath, [
    'issue', 'list',
    '--json', 'number,title,body,labels,url',
    '--state', state,
    ...(label ? ['--label', label] : []),
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

const ghJson = (cwd, args) => {
  try { return JSON.parse(gh(cwd, args)) } catch (e) {
    if (e instanceof GhError) throw e
    throw new GhError(`resposta inválida do gh ${args[0]} ${args[1]}`, 'gh_failed')
  }
}

// ---- acompanhamento de PR (autopilot) ----

export function prStatus(cwd, number) {
  return ghJson(cwd, ['pr', 'view', String(number), '--json',
    'number,url,state,headRefOid,mergeable,reviewDecision,statusCheckRollup,comments,reviews'])
}

// Comentários de linha (review comments) — o `gh pr view` não traz.
export function prInlineComments(cwd, number) {
  const list = ghJson(cwd, ['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'])
  return Array.isArray(list) ? list : []
}

export function mergePR(cwd, number) {
  gh(cwd, ['pr', 'merge', String(number), '--merge'])
}

// Commit de merge de uma PR já mergeada (o que o CI da base vai testar).
export function prMergeSha(cwd, number) {
  return ghJson(cwd, ['pr', 'view', String(number), '--json', 'mergeCommit'])?.mergeCommit?.oid || null
}

// Mergeia a base na branch da PR (o CI roda de novo em cima da base atual).
export function updatePRBranch(cwd, number) {
  gh(cwd, ['pr', 'update-branch', String(number)])
}

export function createPR(cwd, { base, head, title, body }) {
  return gh(cwd, ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body]).trim()
}

// Comentário de bot (cobertura, preview de deploy) não é feedback para a task.
// ponytail: lista por nome; o `gh pr view` não diz se o autor é bot.
const isBot = login => /\[bot\]$|^(github-actions|dependabot|codecov|vercel|netlify|sonarcloud|renovate|coderabbitai)/i.test(login || '')

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

// Resumo puro de uma PR para o autopilot decidir. `seen`: { commentsAt } do
// último feedback já entregue à task.
export function summarizePR(pr, inline = [], seen = {}) {
  const checks = (pr.statusCheckRollup || []).map(c => ({
    name: c.name || c.context || '?',
    url: c.detailsUrl || c.targetUrl || '',
    done: c.__typename === 'StatusContext' ? !['PENDING', 'EXPECTED'].includes(c.state) : c.status === 'COMPLETED',
    failed: FAILED.has(c.conclusion) || FAILED.has(c.state),
  }))
  const failed = checks.filter(c => c.failed)
  const ci = !checks.length ? 'none'
    : failed.length && checks.every(c => c.done) ? 'failed'
    : checks.every(c => c.done) ? 'passed' : 'pending'
  const since = Date.parse(seen.commentsAt || '') || 0
  const comments = [
    ...(pr.comments || []).map(c => ({ at: c.createdAt, author: c.author?.login, body: c.body })),
    ...(pr.reviews || []).filter(r => r.body).map(r => ({ at: r.submittedAt, author: r.author?.login, body: `[review ${r.state}] ${r.body}` })),
    ...inline.map(c => ({ at: c.created_at, author: c.user?.login, body: `${c.path}:${c.line ?? c.original_line ?? '?'} — ${c.body}` })),
  ].filter(c => c.body?.trim() && Date.parse(c.at) > since && !isBot(c.author))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return {
    state: pr.state, sha: pr.headRefOid, ci, failed, comments,
    conflicting: pr.mergeable === 'CONFLICTING',
    changesRequested: pr.reviewDecision === 'CHANGES_REQUESTED',
    latestCommentAt: comments.length ? comments[comments.length - 1].at : seen.commentsAt || null,
  }
}

const MAX_LOG = 4000

// Cauda do log das etapas que falharam de um run do Actions (url .../runs/<id>).
export function failedRunLog(cwd, url) {
  const id = String(url || '').match(/\/actions\/runs\/(\d+)/)?.[1]
  if (!id) return ''
  try { return gh(cwd, ['run', 'view', id, '--log-failed']).slice(-MAX_LOG) } catch { return '' }
}

// Último run concluído do Actions na branch — para o CI quebrado na base virar task.
export function latestRun(cwd, branch) {
  const runs = ghJson(cwd, ['run', 'list', '--branch', branch, '--limit', '10',
    '--json', 'databaseId,conclusion,status,headSha,workflowName,url'])
  return (Array.isArray(runs) ? runs : []).find(r => r.status === 'completed') || null
}

export { GhError }
