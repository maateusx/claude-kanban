import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_CATALOG, PLUGIN_KEYS, PLUGIN_SCOPE,
  findPlugin, normalizeKeys, resolvePluginId, isInstalled,
} from '../src/lib/plugins.js'

test('catálogo cobre os três plugins com marketplace declarado', () => {
  assert.deepEqual(PLUGIN_KEYS, ['ponytail', 'claude-mem', 'obsidian-second-brain'])
  for (const p of PLUGIN_CATALOG) {
    // Sem o marketplace o install falha: nenhum dos três vive no catálogo oficial.
    assert.match(p.marketplace, /^[\w.-]+\/[\w.-]+$/, `${p.key} precisa de um source de marketplace`)
    assert.ok(p.plugin && p.label && p.description)
    assert.ok(['up', 'down'].includes(p.tokenImpact))
  }
  assert.equal(findPlugin('ponytail').marketplace, 'DietrichGebert/ponytail')
  assert.equal(findPlugin('inexistente'), null)
})

// Escopo local: o toggle é por projeto, então não pode escrever no ~/.claude do
// usuário (valeria para toda sessão dele) nem no settings.json versionado.
test('escopo de instalação é local', () => {
  assert.equal(PLUGIN_SCOPE, 'local')
})

test('normalizeKeys descarta desconhecido, duplicado e lixo', () => {
  assert.deepEqual(normalizeKeys(['ponytail', 'ponytail', 'gpt-plugin', 42]), ['ponytail'])
  assert.deepEqual(normalizeKeys(null), [])
  assert.deepEqual(normalizeKeys('ponytail'), [])
})

// O nome do marketplace vem do manifesto do repo, não do nome do repositório —
// por isso o id é resolvido contra o catálogo do CLI em vez de montado na mão.
test('resolvePluginId usa o catálogo do CLI em vez de chutar o marketplace', () => {
  const available = [
    { name: 'outro', pluginId: 'outro@qualquer' },
    { name: 'claude-mem', pluginId: 'claude-mem@thedotmack-claude-mem' },
  ]
  assert.equal(resolvePluginId(findPlugin('claude-mem'), available), 'claude-mem@thedotmack-claude-mem')
  assert.equal(resolvePluginId(findPlugin('ponytail'), available), null)
})

test('isInstalled compara pelo nome, ignorando o marketplace do id', () => {
  const installed = [{ id: 'ponytail@ponytail' }, { id: 'ralph-loop@claude-plugins-official' }]
  assert.ok(isInstalled(findPlugin('ponytail'), installed))
  assert.ok(!isInstalled(findPlugin('claude-mem'), installed))
})
