import test from 'node:test'
import assert from 'node:assert/strict'
import { subtaskLevel, MAX_DECOMPOSE_LEVEL } from '../src/lib/decomposer.js'

// O nível vive numa tag da própria task: é o que impede o autoDecompose de
// quebrar subtask de subtask sem fim.
test('subtaskLevel lê o nível da tag e assume 0 quando não há', () => {
  assert.equal(subtaskLevel({ tags: [] }), 0, 'task original é nível 0')
  assert.equal(subtaskLevel({}), 0, 'task sem tags nenhuma também')
  assert.equal(subtaskLevel({ tags: ['subtask', 'pai:abc', 'nivel:1'] }), 1)
  assert.equal(subtaskLevel({ tags: ['nivel:2'] }), 2)
  assert.equal(subtaskLevel({ tags: ['nivel:'] }), 0, 'tag quebrada não vira NaN')
  assert.equal(subtaskLevel({ tags: ['nivelamento'] }), 0, 'prefixo parecido não conta')
})

test('a decomposição para no teto de níveis', () => {
  const decomposeOf = task => {
    const level = subtaskLevel(task) + 1
    return { level, decompose: level >= MAX_DECOMPOSE_LEVEL ? false : null }
  }
  const spec = decomposeOf({ tags: [] })
  assert.equal(spec.level, 1)
  assert.equal(spec.decompose, null, 'subtask de 1º nível ainda pode ser quebrada pelo autoDecompose')

  const sub = decomposeOf({ tags: [`nivel:${spec.level}`] })
  assert.equal(sub.level, 2)
  assert.equal(sub.decompose, false, 'no último nível a task executa em vez de quebrar de novo')
})
