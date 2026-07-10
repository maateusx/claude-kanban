import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gitSettings, DEFAULT_GIT, prepareWorkspace, cleanupWorkspace, taskBranch, captureDiff } from '../src/lib/git.js'

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
