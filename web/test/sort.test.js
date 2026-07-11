import { describe, it, expect } from 'vitest'
import { sortTasks, SORT_OPTIONS, DEFAULT_SORT } from '../src/sort.js'

const t = (id, priority, created_at, extra = {}) => ({ id, priority, created_at, title: id, ...extra })

const tasks = [
  t('a', 'medium', '2026-01-02T00:00:00Z', { updated_at: '2026-02-01T00:00:00Z' }),
  t('b', 'urgent', '2026-01-03T00:00:00Z', { updated_at: '2026-01-04T00:00:00Z' }),
  t('c', 'medium', '2026-01-01T00:00:00Z', { updated_at: '2026-03-01T00:00:00Z' }),
  t('d', 'low', '2026-01-01T00:00:00Z', { updated_at: '2026-01-01T00:00:00Z' }),
]

describe('sortTasks', () => {
  it('default: prioridade desc, empate pela mais antiga', () => {
    expect(sortTasks(tasks).map(x => x.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('não muta a lista original', () => {
    const before = tasks.map(x => x.id)
    sortTasks(tasks, 'title')
    expect(tasks.map(x => x.id)).toEqual(before)
  })

  it('created / recent / updated / title', () => {
    expect(sortTasks(tasks, 'created').map(x => x.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(sortTasks(tasks, 'recent').map(x => x.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(sortTasks(tasks, 'updated').map(x => x.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(sortTasks(tasks, 'title').map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sort desconhecido cai no default', () => {
    expect(sortTasks(tasks, 'nope').map(x => x.id)).toEqual(sortTasks(tasks).map(x => x.id))
  })

  it('prioridade ausente vale como medium', () => {
    expect(sortTasks([t('x'), t('y', 'high')]).map(v => v.id)).toEqual(['y', 'x'])
  })

  it('toda opção da UI tem comparador', () => {
    expect(SORT_OPTIONS.some(o => o.key === DEFAULT_SORT)).toBe(true)
    for (const o of SORT_OPTIONS) {
      expect(sortTasks(tasks, o.key)).toHaveLength(tasks.length)
    }
  })
})
