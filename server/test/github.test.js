import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listIssues, issueTag, issueDescription, ghAvailable, GH_MISSING } from '../src/lib/github.js'

// Coloca um `gh` falso no início do PATH; o script imprime o que dermos e sai com
// o código pedido. Devolve uma função que restaura o PATH.
function fakeGh({ stdout = '', stderr = '', exit = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'))
  const bin = path.join(dir, 'gh')
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\ncat >&2 <<'EOF'\n${stderr}\nEOF\nexit ${exit}\n`)
  fs.chmodSync(bin, 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}:${prev}`
  return () => { process.env.PATH = prev; fs.rmSync(dir, { recursive: true, force: true }) }
}

function withoutGh() {
  const prev = process.env.PATH
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))
  return () => { process.env.PATH = prev }
}

test('listIssues: normaliza número, título, corpo e labels', () => {
  const restore = fakeGh({
    stdout: JSON.stringify([
      { number: 7, title: ' Bug no parser ', body: ' quebra com aspas ', url: 'https://x/7', labels: [{ name: 'bug' }] },
      { number: 8, title: 'Sem corpo', body: null, labels: [] },
      { number: null, title: 'lixo' },
    ]),
  })
  try {
    const issues = listIssues('/tmp')
    assert.equal(issues.length, 2)
    assert.deepEqual(issues[0], {
      number: 7, title: 'Bug no parser', body: 'quebra com aspas', url: 'https://x/7', labels: ['bug'],
    })
    assert.equal(issues[1].body, '')
    assert.deepEqual(issues[1].labels, [])
  } finally { restore() }
})

test('listIssues: JSON inválido vira erro tratado', () => {
  const restore = fakeGh({ stdout: 'não é json' })
  try {
    assert.throws(() => listIssues('/tmp'), e => e.code === 'gh_failed')
  } finally { restore() }
})

test('listIssues: sem gh no PATH → erro com mensagem clara', () => {
  const restore = withoutGh()
  try {
    assert.equal(ghAvailable(), false)
    assert.throws(() => listIssues('/tmp'), e => e.code === 'gh_missing' && e.message === GH_MISSING)
  } finally { restore() }
})

test('listIssues: gh sem autenticação', () => {
  const restore = fakeGh({ stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', exit: 4 })
  try {
    assert.throws(() => listIssues('/tmp'), e => e.code === 'gh_auth' && /gh auth login/.test(e.message))
  } finally { restore() }
})

test('listIssues: diretório sem repositório do GitHub', () => {
  const restore = fakeGh({ stderr: 'none of the git remotes configured for this repository point to a known GitHub host', exit: 1 })
  try {
    assert.throws(() => listIssues('/tmp'), e => e.code === 'gh_no_repo')
  } finally { restore() }
})

test('issueTag: é a chave do dedupe', () => {
  assert.equal(issueTag(12), 'gh:12')
})

test('issueDescription: mantém o corpo e cita a issue', () => {
  const d = issueDescription({ number: 12, title: 'X', body: 'corpo', url: 'https://gh/12' })
  assert.match(d, /^corpo/)
  assert.match(d, /\[#12\]\(https:\/\/gh\/12\)/)
  assert.match(d, /## Resultado/)
  assert.match(issueDescription({ number: 3, title: 'Y', body: '' }), /issue sem corpo/)
})
