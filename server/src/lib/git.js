import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR } from './paths.js'

export const DEFAULT_GIT = {
  baseBranch: 'main',        // branch de onde o desenvolvimento parte
  pullBeforeStart: false,    // dar pull na branch principal antes de cada task
  useCurrentBranch: false,   // usar a branch atual, sem trocar para a principal
  commitToNewBranch: true,   // commit/push em branch nova (kanban/<task-id>)
  useWorktree: true,         // rodar cada task em um worktree isolado
  autoPush: true,            // dar push automático da branch ao concluir
  autoPR: false,             // abrir PR automaticamente após o push
  autoPRDescription: true,   // gerar a descrição da PR automaticamente (senão, descrição mínima)
}

export const gitSettings = project => ({ ...DEFAULT_GIT, ...(project.git || {}) })

export const taskBranch = taskId => `kanban/${taskId}`

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const detail = (e.stderr || '').toString().trim()
    throw new Error(`git ${args.join(' ')}: ${detail || e.message}`)
  }
}

export function isGitRepo(dir) {
  try { return git(dir, 'rev-parse', '--is-inside-work-tree') === 'true' } catch { return false }
}

// Garante que os metadados do kanban nunca sejam commitados pela sessão (git add -A),
// mesmo que o .gitignore do projeto não esteja commitado na branch base. Escreve os
// padrões no info/exclude do git dir do checkout (idempotente).
const KANBAN_EXCLUDES = [
  '.claude/claude-kanban/tasks/',
  '.claude/claude-kanban/diffs/',
  '.claude/claude-kanban/logs/',
  '.claude/claude-kanban/pending-actions.md',
  '.claude/claude-kanban/meta.json',
]
export function excludeKanbanFromCommits(cwd) {
  try {
    const gitDir = git(cwd, 'rev-parse', '--git-dir') // absoluto ou relativo ao cwd
    const base = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir)
    const info = path.join(base, 'info')
    const file = path.join(info, 'exclude')
    fs.mkdirSync(info, { recursive: true })
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const have = new Set(existing.split('\n'))
    const add = KANBAN_EXCLUDES.filter(l => !have.has(l))
    if (add.length) {
      fs.writeFileSync(file, existing + (existing === '' || existing.endsWith('\n') ? '' : '\n') + add.join('\n') + '\n')
    }
  } catch { /* best-effort */ }
}

const hasRemote = dir => { try { return git(dir, 'remote').length > 0 } catch { return false } }
const currentBranch = dir => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

// Branch atual do checkout principal do projeto (null se não for repo git).
export function projectBranch(dir) {
  if (!isGitRepo(dir)) return null
  try {
    const b = currentBranch(dir)
    return b === 'HEAD' ? null : b // detached HEAD
  } catch { return null }
}

// Há mudanças não commitadas no checkout? (usado para decidir se um checkout que
// falhou pode ser resolvido com stash)
export function isDirty(dir) {
  try { return git(dir, 'status', '--porcelain').length > 0 } catch { return false }
}

// Traz as refs remotas (git fetch --all --prune). Best-effort no-op sem remote.
export function fetchRemotes(dir) {
  if (!isGitRepo(dir) || !hasRemote(dir)) return
  git(dir, 'fetch', '--all', '--prune')
}

// Lista as branches do projeto (locais + remotas sem contraparte local), com a
// atual marcada. Remotas vêm com `remote: true` e podem ser feitas checkout —
// o git cria uma branch local de rastreamento automaticamente.
export function listBranches(dir) {
  if (!isGitRepo(dir)) return []
  let cur = null
  try { cur = currentBranch(dir) } catch {}
  const out = []
  const seen = new Set()
  try {
    for (const name of git(dir, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/')
      .split('\n').map(s => s.trim()).filter(Boolean)) {
      seen.add(name)
      out.push({ name, current: name === cur, remote: false })
    }
  } catch {}
  try {
    for (const ref of git(dir, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/remotes/origin/')
      .split('\n').map(s => s.trim()).filter(Boolean)) {
      const short = ref.replace(/^refs\/remotes\/origin\//, '')
      if (short === 'HEAD' || seen.has(short)) continue // pula o symref origin/HEAD
      seen.add(short)
      out.push({ name: short, current: false, remote: true })
    }
  } catch {}
  return out
}

const remoteBranchRef = (dir, name) => {
  try { git(dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`); return `origin/${name}` }
  catch { return null }
}

// Troca o checkout principal do projeto para uma branch (local ou remota).
// Se o checkout falhar por mudanças não commitadas e `stash` for true, guarda as
// mudanças (git stash push -u) e tenta de novo. Erros (ex.: branch em uso por um
// worktree) são propagados para a UI. Retorna { branch, stashed }.
export function checkoutBranch(dir, name, { stash = false } = {}) {
  if (!isGitRepo(dir)) throw new Error('diretório não é um repositório git')
  const local = branchExists(dir, name)
  const remote = local ? null : remoteBranchRef(dir, name)
  if (!local && !remote) throw new Error(`branch "${name}" não existe`)
  const doCheckout = () => local
    ? git(dir, 'checkout', name)
    : git(dir, 'checkout', '-b', name, '--track', remote)
  let stashed = false
  try {
    doCheckout()
  } catch (e) {
    if (!stash) throw e
    git(dir, 'stash', 'push', '-u', '-m', `claude-kanban: auto-stash antes de trocar para ${name}`)
    stashed = true
    doCheckout()
  }
  return { branch: projectBranch(dir), stashed }
}
const branchExists = (dir, name) => {
  try { git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`); return true } catch { return false }
}

// Atualiza a branch base com o remote sem perder o estado atual do checkout.
function updateBase(root, base) {
  if (!hasRemote(root)) return
  if (currentBranch(root) === base) git(root, 'pull', '--ff-only', 'origin', base)
  else git(root, 'fetch', 'origin', `${base}:${base}`)
}

function resolveStartPoint(root, base) {
  if (branchExists(root, base)) return base
  if (hasRemote(root)) {
    try { git(root, 'fetch', 'origin', base) } catch {}
    try { git(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`); return `origin/${base}` } catch {}
  }
  throw new Error(`branch principal "${base}" não existe no repositório`)
}

// Prepara o workspace da task conforme as configurações de git do projeto.
// Retorna { cwd, branch, worktreeDir, startSha } — nulos quando não se aplicam.
export function prepareWorkspace(project, taskId) {
  const g = gitSettings(project)
  const root = project.path
  if (!isGitRepo(root)) return { cwd: root, branch: null, worktreeDir: null, startSha: null }

  const newBranch = taskBranch(taskId)

  if (g.useWorktree) {
    // Worktree exige branch própria (git não permite a mesma branch em dois worktrees),
    // então aqui a task sempre roda em branch nova.
    let startPoint = 'HEAD'
    if (!g.useCurrentBranch) {
      if (g.pullBeforeStart) updateBase(root, g.baseBranch)
      startPoint = resolveStartPoint(root, g.baseBranch)
    }
    const dir = path.join(HOME_DIR, 'worktrees', project.id, taskId)
    fs.rmSync(dir, { recursive: true, force: true })
    try { git(root, 'worktree', 'prune') } catch {}
    if (branchExists(root, newBranch)) git(root, 'worktree', 'add', dir, newBranch)
    else git(root, 'worktree', 'add', dir, '-b', newBranch, startPoint)
    // .claude/ pode não estar commitado (hooks, settings, tasks) — copia do projeto
    const claudeSrc = path.join(root, '.claude')
    if (fs.existsSync(claudeSrc)) fs.cpSync(claudeSrc, path.join(dir, '.claude'), { recursive: true, force: true })
    excludeKanbanFromCommits(dir)
    return { cwd: dir, branch: newBranch, worktreeDir: dir, startSha: headSha(dir) }
  }

  let branch = currentBranch(root)
  if (!g.useCurrentBranch) {
    if (g.pullBeforeStart) updateBase(root, g.baseBranch)
    if (branch !== g.baseBranch) {
      resolveStartPoint(root, g.baseBranch) === g.baseBranch
        ? git(root, 'checkout', g.baseBranch)
        : git(root, 'checkout', '-b', g.baseBranch, `origin/${g.baseBranch}`)
    }
    branch = g.baseBranch
  }
  if (g.commitToNewBranch) {
    branchExists(root, newBranch) ? git(root, 'checkout', newBranch) : git(root, 'checkout', '-b', newBranch)
    branch = newBranch
  }
  excludeKanbanFromCommits(root)
  return { cwd: root, branch, worktreeDir: null, startSha: headSha(root) }
}

const headSha = dir => { try { return git(dir, 'rev-parse', 'HEAD') } catch { return null } }

const DIFF_MAX_BYTES = 2 * 1024 * 1024

// Diff completo do que a task produziu: mudanças (commitadas ou não) desde o
// commit de partida + arquivos novos ainda não rastreados. As tasks do kanban
// (.claude/claude-kanban/) ficam de fora — o ## Resultado não é "código".
export function captureDiff(cwd, startSha) {
  if (!startSha || !isGitRepo(cwd)) return null
  const exclude = ':(exclude).claude/claude-kanban'
  let diff = ''
  try { diff = git(cwd, 'diff', '--no-color', startSha, '--', '.', exclude) } catch { return null }
  try {
    const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '--', '.', exclude)
    for (const f of untracked.split('\n').filter(Boolean)) {
      if (diff.length > DIFF_MAX_BYTES) break
      // --no-index sai com código 1 quando há diff — o conteúdo vem no stdout do erro
      try {
        diff += (diff ? '\n' : '') + execFileSync('git',
          ['diff', '--no-color', '--no-index', '--', '/dev/null', f],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (e) {
        if (e.stdout) diff += (diff ? '\n' : '') + e.stdout.toString()
      }
    }
  } catch {}
  diff = diff.trim()
  if (!diff) return null
  if (diff.length > DIFF_MAX_BYTES) {
    diff = diff.slice(0, DIFF_MAX_BYTES) + '\n\n[diff truncado em 2MB]'
  }
  return diff + '\n'
}

// Traz o arquivo da task de volta (o modelo edita a cópia do worktree) e remove o worktree.
// A branch da task é preservada — os commits ficam acessíveis no repositório principal.
export function cleanupWorkspace(project, workspace, taskRelPath) {
  if (!workspace?.worktreeDir) return
  // Rede de segurança: se a sessão esqueceu de commitar, NÃO perde o trabalho.
  // Commita o que sobrou na branch da task antes de remover o worktree (que é
  // apagado com --force e levaria junto qualquer mudança não commitada). Os
  // metadados do kanban ficam de fora via info/exclude, então `git add -A` só
  // pega código real.
  try {
    const dir = workspace.worktreeDir
    if (isDirty(dir)) {
      git(dir, 'add', '-A')
      git(dir, 'commit', '--no-verify', '-m',
        'kanban: auto-commit de segurança (mudanças não commitadas pela sessão)')
    }
  } catch { /* best-effort: se falhar, o try abaixo ainda tenta remover */ }
  try {
    const src = path.join(workspace.worktreeDir, taskRelPath)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(project.path, taskRelPath))
  } catch {}
  try {
    git(project.path, 'worktree', 'remove', '--force', workspace.worktreeDir)
  } catch {
    fs.rmSync(workspace.worktreeDir, { recursive: true, force: true })
    try { git(project.path, 'worktree', 'prune') } catch {}
  }
}
