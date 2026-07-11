import { describe, it, expect } from 'vitest'
import { toLocalInput, fromLocalInput, isFuture, fmtWhen, inHours, nextAt } from '../src/App.jsx'

describe('helpers de agendamento', () => {
  it('faz round-trip entre ISO e o valor do datetime-local (fuso local)', () => {
    const iso = new Date(2026, 2, 12, 6, 30).toISOString()
    expect(toLocalInput(iso)).toBe('2026-03-12T06:30')
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso)
  })

  it('trata vazio/inválido sem explodir', () => {
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput('não é data')).toBe('')
    expect(fromLocalInput('')).toBe(null)
    expect(fromLocalInput('qualquer coisa')).toBe(null)
    expect(isFuture(null)).toBe(false)
  })

  it('isFuture separa passado de futuro', () => {
    expect(isFuture(new Date(Date.now() + 60_000).toISOString())).toBe(true)
    expect(isFuture(new Date(Date.now() - 60_000).toISOString())).toBe(false)
  })

  it('fmtWhen usa hoje/amanhã e cai para a data quando é mais longe', () => {
    const at = (days, h, m) => {
      const d = new Date()
      d.setDate(d.getDate() + days)
      d.setHours(h, m, 0, 0)
      return d.toISOString()
    }
    expect(fmtWhen(at(0, 22, 0))).toMatch(/^hoje 22:00$/)
    expect(fmtWhen(at(1, 9, 30))).toMatch(/^amanhã 09:30$/)
    expect(fmtWhen(at(5, 9, 30))).toMatch(/^\d{2}\/\d{2} 09:30$/)
  })

  it('inHours e nextAt caem sempre no futuro', () => {
    expect(isFuture(inHours(1))).toBe(true)
    for (const h of [0, 9, 22, 23]) {
      expect(isFuture(nextAt(h))).toBe(true)
      expect(new Date(nextAt(h)).getHours()).toBe(h)
    }
  })
})
