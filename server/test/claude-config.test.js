import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listConfigFiles, readConfigFile, writeConfigFile } from '../src/lib/claudeConfig.js'

const proj = () => mkdtempSync(path.join(tmpdir(), 'ck-cfg-'))

test('arquivos normais em .claude/ continuam legíveis e editáveis', () => {
  const root = proj()
  mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
  writeFileSync(path.join(root, '.claude/agents/x.md'), 'oi')

  assert.equal(readConfigFile(root, '.claude/agents/x.md').content, 'oi')
  writeConfigFile(root, '.claude/agents/x.md', 'novo')
  assert.equal(readFileSync(path.join(root, '.claude/agents/x.md'), 'utf8'), 'novo')

  // arquivo ainda inexistente (dir pai existe) também é gravável
  writeConfigFile(root, '.claude/agents/novo.md', 'a')
  assert.ok(listConfigFiles(root).some(f => f.path === '.claude/agents/novo.md'))
})

test('symlink de arquivo em .claude/ apontando para fora é rejeitado', () => {
  const root = proj()
  const outside = proj()
  const secret = path.join(outside, 'secret.md')
  writeFileSync(secret, 'segredo')

  mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
  symlinkSync(secret, path.join(root, '.claude/agents/evil.md'))

  assert.throws(() => readConfigFile(root, '.claude/agents/evil.md'), /caminho fora do projeto/)
  assert.throws(() => writeConfigFile(root, '.claude/agents/evil.md', 'hack'), /caminho fora do projeto/)
  assert.equal(readFileSync(secret, 'utf8'), 'segredo')

  // e nem aparece na listagem
  assert.ok(!listConfigFiles(root).some(f => f.path.includes('evil')))
})

test('symlink de diretório em .claude/ apontando para fora é rejeitado', () => {
  const root = proj()
  const outside = proj()
  writeFileSync(path.join(outside, 'config.md'), 'segredo')

  mkdirSync(path.join(root, '.claude'), { recursive: true })
  symlinkSync(outside, path.join(root, '.claude/link'))

  assert.throws(() => readConfigFile(root, '.claude/link/config.md'), /caminho fora do projeto/)
  assert.throws(() => writeConfigFile(root, '.claude/link/novo.md', 'x'), /caminho fora do projeto/)
  assert.ok(!listConfigFiles(root).some(f => f.path.startsWith('.claude/link')))
})
