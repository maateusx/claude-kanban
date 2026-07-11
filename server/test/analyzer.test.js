import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSuggestions, buildPrompt, SUGGESTION_TYPES } from '../src/lib/analyzer.js'

const WANTED = ['melhoria', 'teste']

function wrap(suggestions) {
  return JSON.stringify({ suggestions })
}

test('parseSuggestions: JSON puro', () => {
  const out = parseSuggestions(wrap([
    { title: 'Testar parser', description: 'faz isso', type: 'teste', priority: 'high' },
  ]), WANTED)
  assert.deepEqual(out, [
    { title: 'Testar parser', description: 'faz isso', type: 'teste', priority: 'high' },
  ])
})

test('parseSuggestions: resposta com cercas ```json', () => {
  const text = '```json\n' + wrap([{ title: 'A', type: 'teste' }]) + '\n```'
  const out = parseSuggestions(text, WANTED)
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'A')
  assert.equal(out[0].type, 'teste')
})

test('parseSuggestions: texto antes e depois do JSON', () => {
  const text = `Claro! Aqui vão as sugestões:\n\n${wrap([{ title: 'B', type: 'melhoria' }])}\n\nEspero ter ajudado.`
  const out = parseSuggestions(text, WANTED)
  assert.equal(out.length, 1)
  assert.equal(out[0].title, 'B')
})

test('parseSuggestions: suggestions ausente vira lista vazia', () => {
  assert.deepEqual(parseSuggestions('{"foo":1}', WANTED), [])
})

test('parseSuggestions: suggestions não-array vira lista vazia', () => {
  assert.deepEqual(parseSuggestions('{"suggestions":"nada"}', WANTED), [])
  assert.deepEqual(parseSuggestions('{"suggestions":{"title":"x"}}', WANTED), [])
})

test('parseSuggestions: type fora dos tipos pedidos cai no primeiro wanted', () => {
  const out = parseSuggestions(wrap([
    { title: 'C', type: 'documentacao' }, // tipo válido, mas não pedido
    { title: 'D', type: 'inexistente' },
    { title: 'E' }, // sem type
  ]), WANTED)
  assert.deepEqual(out.map(s => s.type), ['melhoria', 'melhoria', 'melhoria'])
})

test('parseSuggestions: priority inválida ou ausente vira medium', () => {
  const out = parseSuggestions(wrap([
    { title: 'F', type: 'teste', priority: 'critical' },
    { title: 'G', type: 'teste' },
    { title: 'H', type: 'teste', priority: 'urgent' },
  ]), WANTED)
  assert.deepEqual(out.map(s => s.priority), ['medium', 'medium', 'urgent'])
})

test('parseSuggestions: itens sem title são descartados', () => {
  const out = parseSuggestions(wrap([
    { title: 'ok', type: 'teste' },
    { description: 'sem título' },
    { title: '   ', type: 'teste' },
    { title: 42, type: 'teste' },
    null,
  ]), WANTED)
  assert.deepEqual(out.map(s => s.title), ['ok'])
})

test('parseSuggestions: title é trimado e limitado a 200 chars; description não-string vira ""', () => {
  const long = 'x'.repeat(250)
  const out = parseSuggestions(wrap([
    { title: `  ${long}  `, type: 'teste', description: { nope: true } },
  ]), WANTED)
  assert.equal(out[0].title.length, 200)
  assert.equal(out[0].title, 'x'.repeat(200))
  assert.equal(out[0].description, '')
})

test('parseSuggestions: sem JSON lança erro específico', () => {
  const msg = /resposta do modelo não contém JSON/
  assert.throws(() => parseSuggestions('não achei nada para sugerir', WANTED), msg)
  assert.throws(() => parseSuggestions('', WANTED), msg)
  assert.throws(() => parseSuggestions('} {', WANTED), msg)
})

test('parseSuggestions: JSON malformado propaga erro de parse', () => {
  assert.throws(() => parseSuggestions('{"suggestions":[{"title":}]}', WANTED), SyntaxError)
})

test('buildPrompt: lista só os tipos pedidos, com suas descrições', () => {
  const prompt = buildPrompt(['teste', 'correcao'])
  assert.match(prompt, new RegExp(`- "teste": ${SUGGESTION_TYPES.teste}`))
  assert.match(prompt, new RegExp(`- "correcao": ${SUGGESTION_TYPES.correcao}`))
  assert.ok(!prompt.includes('- "feature"'))
  assert.match(prompt, /Responda SOMENTE com um JSON válido/)
})
