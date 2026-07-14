import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  gitSettings, DEFAULT_GIT, prepareWorkspace, cleanupWorkspace, taskBranch, captureDiff,
  mergeTaskBranch, deleteTaskBranch,
} from '../src/lib/git.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-git-'))
  sh(root, 'init', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@test')
  sh(root, 'config', 'user.name', 'test')
  writeFileSync(path.join(root, 'a.txt'), 'a\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-m', 'init')
  return root
}
const projectFor = (root, git = {}) => ({ id: `p${Math.floor(Math.abs(Math.sin(root.length)) * 1e6)}`, path: root, git })

test('gitSettings aplica defaults e preserva overrides', () => {
  assert.deepEqual(gitSettings({}), DEFAULT_GIT)
  const g = gitSettings({ git: { baseBranch: 'develop', useWorktree: false } })
  assert.equal(g.baseBranch, 'develop')
  assert.equal(g.useWorktree, false)
  assert.equal(g.commitToNewBranch, true)
})

test('diretório sem git: roda direto no projeto', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-nogit-'))
  const ws = prepareWorkspace(projectFor(root), 't1')
  assert.deepEqual(ws, { cwd: root, branch: null, worktreeDir: null, startSha: null })
})

test('worktree: cria branch nova a partir da base e limpa preservando a branch', () => {
  const root = repo()
  const project = projectFor(root)
  const ws = prepareWorkspace(project, 'tw1')
  assert.equal(ws.branch, taskBranch('tw1'))
  assert.ok(ws.worktreeDir && existsSync(ws.worktreeDir))
  assert.equal(sh(ws.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'kanban/tw1')
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'checkout principal não muda')

  // simula resultado escrito no worktree e traz de volta
  mkdirSync(path.join(ws.cwd, 'sub'), { recursive: true })
  mkdirSync(path.join(root, 'sub'), { recursive: true })
  writeFileSync(path.join(ws.cwd, 'sub/task.md'), 'resultado\n')
  cleanupWorkspace(project, ws, 'sub/task.md')
  assert.equal(readFileSync(path.join(root, 'sub/task.md'), 'utf8'), 'resultado\n')
  assert.ok(!existsSync(ws.worktreeDir))
  assert.equal(sh(root, 'rev-parse', '--verify', '--quiet', 'refs/heads/kanban/tw1') !== '', true)
})

test('sem worktree: checkout da base + branch nova', () => {
  const root = repo()
  sh(root, 'checkout', '-b', 'outra')
  const ws = prepareWorkspace(projectFor(root, { useWorktree: false }), 'tn1')
  assert.equal(ws.cwd, root)
  assert.equal(ws.branch, 'kanban/tn1')
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'kanban/tn1')
})

test('sem worktree, branch atual, sem branch nova: fica onde está', () => {
  const root = repo()
  sh(root, 'checkout', '-b', 'feature-x')
  const ws = prepareWorkspace(projectFor(root, { useWorktree: false, useCurrentBranch: true, commitToNewBranch: false }), 'tc1')
  assert.equal(ws.branch, 'feature-x')
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-x')
})

test('captureDiff: commits, não commitados e untracked; ignora .claude/claude-kanban', () => {
  const root = repo()
  mkdirSync(path.join(root, '.claude/claude-kanban/tasks/done'), { recursive: true })
  writeFileSync(path.join(root, '.claude/claude-kanban/tasks/done/t.md'), 'task\n')
  sh(root, 'add', '.'); sh(root, 'commit', '-m', 'task')
  const start = sh(root, 'rev-parse', 'HEAD')

  assert.equal(captureDiff(root, start), null, 'sem mudanças → null')

  writeFileSync(path.join(root, 'a.txt'), 'a\nb\n')                 // modificado + commitado
  sh(root, 'commit', '-am', 'edita')
  writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc\n')              // modificado, não commitado
  writeFileSync(path.join(root, 'novo.txt'), 'novo\n')              // untracked
  writeFileSync(path.join(root, '.claude/claude-kanban/tasks/done/t.md'), 'task\nresultado\n')

  const diff = captureDiff(root, start)
  assert.match(diff, /\+b\n\+c/)
  assert.match(diff, /novo\.txt/)
  assert.ok(!diff.includes('claude-kanban'), 'tasks do kanban fora do diff')
  assert.equal(captureDiff(root, null), null)
})

test('base inexistente sem remote: erro claro', () => {
  const root = repo()
  assert.throws(() => prepareWorkspace(projectFor(root, { baseBranch: 'develop', useWorktree: false })), /develop/)
})

// ---- aprovar / descartar o resultado de uma task ----

// Cria a branch da task com um commit e devolve o checkout para a base.
function taskWork(root, taskId, file = 'nova.txt', content = 'x\n') {
  const branch = taskBranch(taskId)
  const base = sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  sh(root, 'checkout', '-b', branch)
  writeFileSync(path.join(root, file), content)
  sh(root, 'add', '.'); sh(root, 'commit', '-m', `work ${taskId}`)
  sh(root, 'checkout', base)
  return branch
}

test('aprovar: mergeia a branch da task na base e preserva a branch atual do checkout', () => {
  const root = repo()
  const project = projectFor(root, { autoPush: false })
  const branch = taskWork(root, 'ta1')
  sh(root, 'checkout', '-b', 'outra')   // o humano está em outra branch

  const res = mergeTaskBranch(project, branch)
  assert.equal(res.merged, true)
  assert.equal(res.base, 'main')
  assert.equal(res.pushed, false)
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'outra', 'volta para a branch de origem')
  assert.match(sh(root, 'log', '--oneline', 'main'), /work ta1/)
  assert.match(sh(root, 'log', '-1', '--pretty=%s', 'main'), /Merge branch 'kanban\/ta1'/)
})

test('aprovar: conflito sobe erro com a mensagem do git e não deixa o repo sujo', () => {
  const root = repo()
  const project = projectFor(root, { autoPush: false })
  const branch = taskWork(root, 'ta2', 'a.txt', 'versão da task\n')
  writeFileSync(path.join(root, 'a.txt'), 'versão da base\n')     // mesma linha, na base
  sh(root, 'commit', '-am', 'base edita a.txt')

  assert.throws(() => mergeTaskBranch(project, branch), e => e.conflict === true && /a\.txt/.test(e.message))
  assert.equal(sh(root, 'status', '--porcelain'), '', 'merge abortado, working tree limpo')
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
})

test('aprovar: recusa a própria base e checkout sujo', () => {
  const root = repo()
  const project = projectFor(root, { autoPush: false })
  const branch = taskWork(root, 'ta3')
  assert.throws(() => mergeTaskBranch(project, 'main'), /base/)
  writeFileSync(path.join(root, 'a.txt'), 'sujo\n')
  assert.throws(() => mergeTaskBranch(project, branch), /não commitadas/)
})

test('descartar: apaga a branch da task, inclusive presa em um worktree', () => {
  const root = repo()
  const project = projectFor(root)
  const ws = prepareWorkspace(project, 'td1')      // o worktree segura kanban/td1
  assert.ok(existsSync(ws.worktreeDir))

  assert.deepEqual(deleteTaskBranch(project, taskBranch('td1')), { deleted: true })
  assert.equal(sh(root, 'branch', '--list', 'kanban/td1'), '')
  assert.ok(!existsSync(ws.worktreeDir))
  assert.deepEqual(deleteTaskBranch(project, taskBranch('td1')), { deleted: false }, 'idempotente')
})

test('descartar: recusa apagar a base e sai da branch se ela estiver checada', () => {
  const root = repo()
  const project = projectFor(root, { useWorktree: false })
  assert.throws(() => deleteTaskBranch(project, 'main'), /base/)
  const branch = taskWork(root, 'td2')
  sh(root, 'checkout', branch)
  assert.deepEqual(deleteTaskBranch(project, branch), { deleted: true })
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
})
