import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../templates/guard.mjs', import.meta.url))

function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'ck-guard-'))
  mkdirSync(path.join(root, '.claude/claude-kanban'), { recursive: true })
  writeFileSync(path.join(root, '.claude/claude-kanban/pending-actions.md'), '')
  return root
}

function run(mode, toolInput, { cwd, env = {} } = {}) {
  const root = cwd || makeProject()
  const res = spawnSync('node', [GUARD, mode], {
    input: JSON.stringify({ tool_name: 'x', tool_input: toolInput, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  })
  assert.equal(res.status, 0, res.stderr)
  const out = res.stdout.trim()
  return { denied: out !== '' ? JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny' : false, root, out }
}

function gitProject(branch) {
  const root = makeProject()
  const g = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', 't@t.t']); g(['config', 'user.name', 't'])
  writeFileSync(path.join(root, 'a.txt'), 'x')
  g(['add', '.']); g(['commit', '-qm', 'init'])
  return root
}

// ---- Regra A: .env ----
test('deny Read de .env', () => assert.ok(run('file', { file_path: '/x/.env' }).denied))
test('deny Read de .env.production', () => assert.ok(run('file', { file_path: '.env.production' }).denied))
test('allow Read de .env.example', () => assert.ok(!run('file', { file_path: '.env.example' }).denied))
test('allow Read de .env.template', () => assert.ok(!run('file', { file_path: 'x/.env.template' }).denied))
test('allow Read arquivo normal', () => assert.ok(!run('file', { file_path: 'src/env.ts' }).denied))
test('deny cat .env', () => assert.ok(run('bash', { command: 'cat .env' }).denied))
test('deny grep KEY .env.local', () => assert.ok(run('bash', { command: 'grep KEY .env.local' }).denied))
test('deny echo >> .env', () => assert.ok(run('bash', { command: 'echo "A=1" >> .env' }).denied))
test('deny source .env', () => assert.ok(run('bash', { command: 'source ./.env' }).denied))
test('allow cat .env.example', () => assert.ok(!run('bash', { command: 'cat .env.example' }).denied))
test('allow npm run dev', () => assert.ok(!run('bash', { command: 'npm run dev' }).denied))

// ---- Regra B: git main/master ----
test('deny git commit em main', () => {
  const root = gitProject('main')
  assert.ok(run('bash', { command: 'git commit -m "x"' }, { cwd: root }).denied)
})
test('allow git commit em feature branch', () => {
  const root = gitProject('feature/x')
  assert.ok(!run('bash', { command: 'git commit -m "x"' }, { cwd: root }).denied)
})
test('deny git push origin main', () => {
  const root = gitProject('feature/x')
  assert.ok(run('bash', { command: 'git push origin main' }, { cwd: root }).denied)
})
test('deny git push origin HEAD:main', () => {
  const root = gitProject('feature/x')
  assert.ok(run('bash', { command: 'git push origin HEAD:main' }, { cwd: root }).denied)
})
test('deny git push --force em main', () => {
  const root = gitProject('main')
  assert.ok(run('bash', { command: 'git push --force origin main' }, { cwd: root }).denied)
})
test('allow git push origin feature/x', () => {
  const root = gitProject('feature/x')
  assert.ok(!run('bash', { command: 'git push origin feature/x' }, { cwd: root }).denied)
})
test('deny git merge em main', () => {
  const root = gitProject('main')
  assert.ok(run('bash', { command: 'git merge feature/x' }, { cwd: root }).denied)
})
test('allow git merge em feature', () => {
  const root = gitProject('feature/x')
  assert.ok(!run('bash', { command: 'git merge other' }, { cwd: root }).denied)
})
test('allow git checkout main / git pull / git status', () => {
  const root = gitProject('main')
  assert.ok(!run('bash', { command: 'git checkout main' }, { cwd: root }).denied)
  assert.ok(!run('bash', { command: 'git status' }, { cwd: root }).denied)
})

// ---- Regra C: deleção de branch ----
test('deny git branch -D', () => {
  const { denied, root } = run('bash', { command: 'git branch -D feature' })
  assert.ok(denied)
  const pa = readFileSync(path.join(root, '.claude/claude-kanban/pending-actions.md'), 'utf8')
  assert.match(pa, /git branch -D feature/)
})
test('deny git push --delete', () => assert.ok(run('bash', { command: 'git push origin --delete old' }).denied))
test('deny git push origin :branch', () => assert.ok(run('bash', { command: 'git push origin :old' }).denied))
test('deny git worktree remove --force', () => assert.ok(run('bash', { command: 'git worktree remove --force ../wt' }).denied))
test('allow git branch (listar/criar)', () => {
  assert.ok(!run('bash', { command: 'git branch' }).denied)
  assert.ok(!run('bash', { command: 'git branch nova' }).denied)
})

// ---- Regra D: deleção fora do projeto ----
test('deny rm de arquivo externo + registra pending-action com task id', () => {
  const { denied, root } = run('bash', { command: 'rm /tmp/fora.txt' }, { env: { CLAUDE_KANBAN_TASK_ID: 'k7x2m9' } })
  assert.ok(denied)
  const pa = readFileSync(path.join(root, '.claude/claude-kanban/pending-actions.md'), 'utf8')
  assert.match(pa, /rm \/tmp\/fora\.txt/)
  assert.match(pa, /task: k7x2m9/)
  assert.match(pa, /status: pending/)
})
test('deny rm -rf ~/x', () => assert.ok(run('bash', { command: 'rm -rf ~/x' }).denied))
test('deny rm ../../etc/passwd', () => assert.ok(run('bash', { command: 'rm ../../etc/passwd' }).denied))
test('deny find / -delete', () => assert.ok(run('bash', { command: "find / -name '*.log' -delete" }).denied))
test('deny rm -rf do próprio root', () => {
  const root = makeProject()
  assert.ok(run('bash', { command: `rm -rf ${root}` }, { cwd: root }).denied)
})
test('allow rm dentro do projeto', () => {
  const root = makeProject()
  mkdirSync(path.join(root, 'src/tmp'), { recursive: true })
  writeFileSync(path.join(root, 'src/tmp.txt'), 'x')
  assert.ok(!run('bash', { command: 'rm ./src/tmp.txt' }, { cwd: root }).denied)
})
test('allow rm -rf node_modules interno', () => {
  const root = makeProject()
  assert.ok(!run('bash', { command: 'rm -rf node_modules' }, { cwd: root }).denied)
})
test('allow ls e comandos não destrutivos', () => {
  assert.ok(!run('bash', { command: 'ls -la /etc' }).denied)
})
