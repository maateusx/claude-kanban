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
  '.claude/claude-kanban/notes.md',
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

// O worktree precisa do `.claude/` do projeto (hooks, settings, skill, e o
// arquivo da própria task, que o agente edita). Não precisa do que é artefato
// puro do orquestrador: os logs de execução são JSONL de até 8MB por task e os
// diffs acompanham. Copiar isso para dentro do worktree só criava I/O e material
// para o agente ler por engano num Glob — nada ali ajuda a executar a task.
// Tasks já concluídas ficam de fora pelo mesmo motivo: o board inteiro dentro do
// contexto do agente é custo sem retorno.
const WORKTREE_SKIP = ['logs', 'diffs', path.join('tasks', 'done'), path.join('tasks', 'archived')]
  .map(p => path.join('.claude', 'claude-kanban', p))

export function copyClaudeDir(root, dest) {
  fs.cpSync(path.join(root, '.claude'), dest, {
    recursive: true,
    force: true,
    filter: src => {
      const rel = path.relative(root, src)
      return !WORKTREE_SKIP.some(skip => rel === skip || rel.startsWith(skip + path.sep))
    },
  })
}

// Branch de integração de uma task desmembrada: as subtasks partem dela e voltam
// para ela (mergeIntoBranch), então a 2ª subtask enxerga o código da 1ª. Criada
// da base na primeira vez que alguma filha precisa dela.
function ensureParentBranch(root, g, parentId) {
  const branch = taskBranch(parentId)
  if (!branchExists(root, branch)) {
    if (g.pullBeforeStart) updateBase(root, g.baseBranch)
    git(root, 'branch', branch, resolveStartPoint(root, g.baseBranch))
  }
  return branch
}

// Prepara o workspace da task conforme as configurações de git do projeto.
// parentId: task de que esta é subtask — o ponto de partida vira a branch do pai.
// Retorna { cwd, branch, worktreeDir, startSha } — nulos quando não se aplicam.
// Branch já existente (integração, retry, feedback de PR, conflito): startSha
// vira o ponto em que ela saiu do startPoint, para o diff (e a revisão, e a
// política de auto-merge) cobrir tudo que ela acumula, não só a última sessão.
export function prepareWorkspace(project, taskId, { parentId = null } = {}) {
  const g = gitSettings(project)
  const root = project.path
  if (!isGitRepo(root)) return { cwd: root, branch: null, worktreeDir: null, startSha: null }

  const newBranch = taskBranch(taskId)
  const parentBranch = parentId ? ensureParentBranch(root, g, parentId) : null

  if (g.useWorktree) {
    // Worktree exige branch própria (git não permite a mesma branch em dois worktrees),
    // então aqui a task sempre roda em branch nova.
    let startPoint = headSha(root)
    if (parentBranch) startPoint = parentBranch
    else if (!g.useCurrentBranch) {
      if (g.pullBeforeStart) updateBase(root, g.baseBranch)
      startPoint = resolveStartPoint(root, g.baseBranch)
    }
    const dir = path.join(HOME_DIR, 'worktrees', project.id, taskId)
    fs.rmSync(dir, { recursive: true, force: true })
    try { git(root, 'worktree', 'prune') } catch {}
    const existed = branchExists(root, newBranch)
    if (existed) git(root, 'worktree', 'add', dir, newBranch)
    else git(root, 'worktree', 'add', dir, '-b', newBranch, startPoint)
    // .claude/ pode não estar commitado (hooks, settings, tasks) — copia do projeto
    if (fs.existsSync(path.join(root, '.claude'))) copyClaudeDir(root, path.join(dir, '.claude'))
    excludeKanbanFromCommits(dir)
    let startSha = headSha(dir)
    // baseSha: de onde a branch saiu — é contra ele que o verify de referência
    // roda (numa branch retomada, o HEAD já tem commits da própria task).
    let baseSha = startSha
    try { baseSha = git(root, 'merge-base', startPoint, newBranch) } catch {}
    if (existed) startSha = baseSha
    return { cwd: dir, branch: newBranch, worktreeDir: dir, startSha, baseSha, startPoint }
  }

  let branch = currentBranch(root)
  let baseSha = null
  if (parentBranch) {
    if (branch !== parentBranch) git(root, 'checkout', parentBranch)
    branch = parentBranch
  } else if (!g.useCurrentBranch) {
    if (g.pullBeforeStart) updateBase(root, g.baseBranch)
    if (branch !== g.baseBranch) {
      resolveStartPoint(root, g.baseBranch) === g.baseBranch
        ? git(root, 'checkout', g.baseBranch)
        : git(root, 'checkout', '-b', g.baseBranch, `origin/${g.baseBranch}`)
    }
    branch = g.baseBranch
  }
  baseSha = headSha(root)
  if (g.commitToNewBranch) {
    branchExists(root, newBranch) ? git(root, 'checkout', newBranch) : git(root, 'checkout', '-b', newBranch)
    branch = newBranch
  }
  excludeKanbanFromCommits(root)
  const startPoint = g.commitToNewBranch ? (parentBranch || (g.useCurrentBranch ? baseSha : g.baseBranch)) : null
  return { cwd: root, branch, worktreeDir: null, startSha: headSha(root), baseSha, startPoint }
}

// De onde medir o diff no FIM da sessão: o merge-base com o ponto de partida,
// recalculado — se a sessão mergeou a base (resolução de conflito), o que veio
// da base não é trabalho da task.
export function diffBase(ws) {
  if (!ws?.startPoint) return ws?.startSha || null
  try { return git(ws.cwd, 'merge-base', ws.startPoint, 'HEAD') } catch { return ws.startSha || null }
}

// Worktree novo não tem dependências: sem isso o verify da base falha por
// "módulo não encontrado" e toda falha da task parece nova. Reaproveita os
// node_modules do checkout (raiz e um nível abaixo, para monorepos).
// ponytail: dependências da base podem diferir das do checkout; npm ci no
// worktree se isso gerar falso positivo.
function linkNodeModules(root, dir) {
  const subs = ['', ...fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map(e => e.name)]
  for (const sub of subs) {
    const src = path.join(root, sub, 'node_modules')
    const dest = path.join(dir, sub, 'node_modules')
    if (!fs.existsSync(src) || !fs.existsSync(path.dirname(dest)) || fs.existsSync(dest)) continue
    try { fs.symlinkSync(src, dest, 'dir') } catch {}
  }
}

// Roda fn(dir) num worktree destacado em `sha` e remove o worktree no fim.
// Usado pelo verify de referência: saber se a base já falhava sem tocar no
// checkout de ninguém.
export function withDetachedWorktree(root, sha, fn) {
  const dir = path.join(HOME_DIR, 'worktrees', '_baseline', `${path.basename(root)}-${sha.slice(0, 12)}`)
  fs.rmSync(dir, { recursive: true, force: true })
  try { git(root, 'worktree', 'prune') } catch {}
  git(root, 'worktree', 'add', '--detach', dir, sha)
  try {
    linkNodeModules(root, dir)
    return fn(dir)
  } finally {
    try { git(root, 'worktree', 'remove', '--force', dir) } catch {
      fs.rmSync(dir, { recursive: true, force: true })
      try { git(root, 'worktree', 'prune') } catch {}
    }
  }
}

// Arquivos e linhas (+/-) tocados por um diff unificado — base da política de auto-merge.
export function diffStats(diff) {
  const files = new Set()
  let lines = 0
  for (const l of String(diff || '').split('\n')) {
    const m = l.match(/^diff --git a\/(.+?) b\//)
    if (m) files.add(m[1])
    else if ((l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))) lines++
  }
  return { files: [...files], lines }
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

// Erro de conflito de merge — o index.js traduz em 409 para a UI.
export class MergeConflictError extends Error {
  constructor(message) { super(message); this.name = 'MergeConflictError'; this.conflict = true }
}

// Merge da branch da task na branch base do projeto. Ação explícita do humano
// (o guard.mjs bloqueia isso para a *sessão* do agente, não para o servidor).
// O merge acontece no checkout principal: exige working tree limpo, troca para a
// base, mergeia e volta para a branch em que o checkout estava. Em conflito, faz
// `merge --abort` — o repo nunca fica sujo — e sobe MergeConflictError.
export function mergeTaskBranch(project, branch, { noFF = true } = {}) {
  const root = project.path
  const base = gitSettings(project).baseBranch
  if (!isGitRepo(root)) throw new Error('diretório não é um repositório git')
  if (!branchExists(root, branch)) throw new Error(`branch "${branch}" não existe`)
  if (branch === base) throw new Error(`a branch da task é a própria base ("${base}") — nada a mergear`)
  if (isDirty(root)) throw new Error('o checkout do projeto tem mudanças não commitadas — commite ou guarde no stash antes de aprovar')
  if (!branchExists(root, base)) throw new Error(`branch base "${base}" não existe no repositório`)

  const original = currentBranch(root)
  if (original !== base) git(root, 'checkout', base)
  try {
    const before = headSha(root)
    try {
      // O git põe os "CONFLICT (content): ..." no stdout, não no stderr — daí o
      // execFileSync direto, para a UI receber a mensagem real do git.
      execFileSync('git',
        ['merge', ...(noFF ? ['--no-ff'] : ['--ff']), '-m', `Merge branch '${branch}' (claude-kanban)`, branch],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      const detail = [e.stdout, e.stderr].map(s => (s || '').toString().trim()).filter(Boolean).join('\n')
      try { git(root, 'merge', '--abort') } catch {}
      throw new MergeConflictError(detail || e.message)
    }
    const after = headSha(root)
    let pushed = false
    let pushError = null
    if (gitSettings(project).autoPush && hasRemote(root)) {
      try { git(root, 'push', 'origin', base); pushed = true } catch (e) { pushError = e.message }
    }
    return { base, branch, merged: before !== after, sha: after, pushed, pushError }
  } finally {
    // Devolve o checkout para onde o humano estava — o merge não deve sequestrar a branch atual.
    if (original !== base && branchExists(root, original)) { try { git(root, 'checkout', original) } catch {} }
  }
}

// Merge de `branch` em `into` sem checkout nenhum (merge-tree + commit-tree):
// a branch de integração de uma task desmembrada não está checada em lugar
// algum enquanto as filhas rodam. Fast-forward quando dá; conflito sobe
// MergeConflictError e nada é escrito. Exige git >= 2.38.
export function mergeIntoBranch(root, branch, into) {
  const head = git(root, 'rev-parse', into)
  const tip = git(root, 'rev-parse', branch)
  if (head === tip) return { sha: head, merged: false }
  const isAncestor = (a, b) => {
    try { git(root, 'merge-base', '--is-ancestor', a, b); return true } catch { return false }
  }
  if (isAncestor(tip, head)) return { sha: head, merged: false }
  let sha = tip
  if (!isAncestor(head, tip)) {
    let tree
    try {
      tree = execFileSync('git', ['merge-tree', '--write-tree', head, tip],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0].trim()
    } catch (e) {
      // Conflito: merge-tree sai com 1 e lista os arquivos no stdout.
      throw new MergeConflictError((e.stdout || e.message).toString().trim())
    }
    sha = git(root, 'commit-tree', tree, '-p', head, '-p', tip, '-m', `Merge branch '${branch}' into ${into} (claude-kanban)`)
  }
  git(root, 'update-ref', `refs/heads/${into}`, sha, head)
  return { sha, merged: true }
}

// Descarta o trabalho da task: apaga a branch local (e o worktree, se sobrou).
// A branch remota NÃO é apagada — remover coisa do remote continua sendo ação humana.
export function deleteTaskBranch(project, branch) {
  const root = project.path
  const base = gitSettings(project).baseBranch
  if (!isGitRepo(root)) throw new Error('diretório não é um repositório git')
  if (branch === base) throw new Error(`recusando apagar a branch base ("${base}")`)
  if (!branchExists(root, branch)) return { deleted: false }

  // A branch pode estar checada no checkout principal ou presa em um worktree órfão.
  if (currentBranch(root) === branch) {
    if (isDirty(root)) throw new Error('o checkout do projeto está na branch da task e com mudanças não commitadas')
    git(root, 'checkout', base)
  }
  for (const wt of listWorktreesForBranch(root, branch)) {
    try { git(root, 'worktree', 'remove', '--force', wt) } catch { fs.rmSync(wt, { recursive: true, force: true }) }
  }
  try { git(root, 'worktree', 'prune') } catch {}
  git(root, 'branch', '-D', branch)
  return { deleted: true }
}

// Diretórios de worktree que têm `branch` checada (git worktree list --porcelain).
function listWorktreesForBranch(root, branch) {
  let out = ''
  try { out = git(root, 'worktree', 'list', '--porcelain') } catch { return [] }
  const dirs = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && cur) dirs.push(cur)
  }
  return dirs.filter(d => path.resolve(d) !== path.resolve(root))
}
// PR aberta pela sessão (autoPR) para a branch da task. Depende do `gh` estar
// instalado e autenticado; sem ele, ou sem PR aberta, devolve null — a UI
// simplesmente não mostra o botão. Precisa rodar antes do worktree ser removido.
export function capturePR(cwd, branch) {
  if (!branch || !isGitRepo(cwd)) return null
  try {
    const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'url,number,state'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pr = JSON.parse(out)
    if (!pr?.url) return null
    return { url: pr.url, number: pr.number ?? null, state: pr.state ?? null }
  } catch { return null }
}

// Traz o arquivo da task de volta (o modelo edita a cópia do worktree) e remove o worktree.
// A branch da task é preservada — os commits ficam acessíveis no repositório principal.
export function cleanupWorkspace(project, workspace, taskRelPath) {
  if (!workspace?.worktreeDir) return
  try {
    const src = path.join(workspace.worktreeDir, taskRelPath)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(project.path, taskRelPath))
  } catch {}
  removeWorktree(project.path, workspace.worktreeDir)
}

// Rede de segurança: se a sessão esqueceu de commitar, NÃO perde o trabalho.
// Commita o que sobrou na branch da task antes de remover o worktree (que é
// apagado com --force e levaria junto qualquer mudança não commitada). Os
// metadados do kanban ficam de fora via info/exclude, então `git add -A` só
// pega código real.
function removeWorktree(root, dir) {
  try {
    if (isDirty(dir)) {
      git(dir, 'add', '-A')
      git(dir, 'commit', '--no-verify', '-m',
        'kanban: auto-commit de segurança (mudanças não commitadas pela sessão)')
    }
  } catch { /* best-effort: se falhar, o try abaixo ainda tenta remover */ }
  try {
    git(root, 'worktree', 'remove', '--force', dir)
  } catch {
    fs.rmSync(dir, { recursive: true, force: true })
    try { git(root, 'worktree', 'prune') } catch {}
  }
}

// ---- limpeza de branches kanban/* e worktrees órfãos ----
// Ação do servidor (o guard proíbe a *sessão* de apagar branch). Conservadora:
// só é candidata a branch cujo conteúdo já está salvo em outro lugar — contida na
// base, ou de task com tag merged (squash no GitHub não deixa ancestral),
// integrada (está na branch do pai) ou discarded (o humano descartou). Branch de
// task em backlog/todo/doing, com PR aberta, checada num worktree vivo ou com
// trabalho não mergeado de task sem essas tags nunca entra.
const SAFE_TAGS = ['merged', 'integrada', 'discarded']
const ACTIVE_STATUSES = ['backlog', 'todo', 'doing']

function worktreeList(root) {
  let out = ''
  try { out = git(root, 'worktree', 'list', '--porcelain') } catch { return [] }
  const list = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ dir: line.slice('worktree '.length), branch: null })
    else if (line.startsWith('branch refs/heads/') && list.length) list.at(-1).branch = line.slice('branch refs/heads/'.length)
  }
  return list
}

// tasks: listTasks do projeto. busy(taskId): o runner está com a task (ativa ou na fila).
// Worktree de task é criado e removido pelo runner no mesmo run, então qualquer
// um em worktrees/<projeto>/ sem sessão viva sobrou de um crash.
// Devolve { branches: [{ name, taskId, reason }], worktrees: [{ dir, taskId, reason }] }.
export function cleanupCandidates(project, tasks, busy = () => false) {
  const root = project.path
  if (!isGitRepo(root)) return { branches: [], worktrees: [] }
  const byId = new Map(tasks.map(t => [t.id, t]))
  const wts = worktreeList(root)
  // realpath: no macOS o git devolve /private/var/... para um HOME em /var/...
  const real = p => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const wtRoot = real(path.join(HOME_DIR, 'worktrees', project.id))

  const worktrees = []
  for (const w of wts) {
    if (real(path.dirname(w.dir)) !== wtRoot) continue // checkout principal, _baseline, outros projetos
    const taskId = path.basename(w.dir)
    if (busy(taskId)) continue
    const reason = !fs.existsSync(w.dir) ? 'missing' : byId.has(taskId) ? 'idle' : 'task-gone'
    worktrees.push({ dir: w.dir, taskId, reason })
  }

  const base = gitSettings(project).baseBranch
  const baseRef = branchExists(root, base) ? base : remoteBranchRef(root, base)
  const merged = new Set()
  if (baseRef) {
    try {
      git(root, 'branch', '--format=%(refname:short)', '--merged', baseRef, '--list', 'kanban/*')
        .split('\n').filter(Boolean).forEach(b => merged.add(b))
    } catch {}
  }
  // Branch checada num worktree que vai continuar existindo (checkout principal ou sessão viva) fica.
  const orphan = new Set(worktrees.map(w => w.dir))
  const checkedOut = new Set(wts.filter(w => !orphan.has(w.dir)).map(w => w.branch))

  const branches = []
  let names = []
  try { names = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/kanban/').split('\n').filter(Boolean) } catch {}
  for (const name of names) {
    const taskId = name.slice('kanban/'.length)
    const t = byId.get(taskId)
    if (name === base || checkedOut.has(name) || busy(taskId)) continue
    if (t && ACTIVE_STATUSES.includes(t.status)) continue
    if (t?.run?.pr?.number && (t.run.pr.state ?? 'OPEN') === 'OPEN') continue
    const reason = merged.has(name) ? 'merged' : SAFE_TAGS.find(x => (t?.tags || []).includes(x))
    if (reason) branches.push({ name, taskId, reason })
  }
  return { branches, worktrees }
}

// Remove os candidatos — todos, ou só os de `only` ({ branches: [nomes],
// worktrees: [dirs] }, o lote que o humano aprovou). Recalcula na hora: o que
// deixou de ser candidato entre a listagem e a aprovação é ignorado. Worktrees
// primeiro, para liberar as branches presas neles. remote: apaga também
// origin/<branch>, se existir.
export function applyCleanup(project, tasks, { busy, only, remote = false } = {}) {
  const root = project.path
  const res = { branches: [], worktrees: [], errors: [] }
  const pick = (list, key, allowed) => (allowed ? list.filter(x => allowed.includes(x[key])) : list)
  for (const w of pick(cleanupCandidates(project, tasks, busy).worktrees, 'dir', only?.worktrees)) {
    if (w.reason !== 'missing') removeWorktree(root, w.dir)
    res.worktrees.push(w.dir)
  }
  try { git(root, 'worktree', 'prune') } catch {}
  const withRemote = remote && hasRemote(root)
  for (const b of pick(cleanupCandidates(project, tasks, busy).branches, 'name', only?.branches)) {
    try { git(root, 'branch', '-D', b.name) } catch (e) { res.errors.push(e.message); continue }
    res.branches.push(b.name)
    if (withRemote && remoteBranchRef(root, b.name)) {
      try { git(root, 'push', 'origin', '--delete', b.name) } catch (e) { res.errors.push(e.message) }
    }
  }
  return res
}
