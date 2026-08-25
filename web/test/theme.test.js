import { describe, it, expect, beforeEach, vi } from 'vitest'
import { THEME_KEY, loadTheme, saveTheme, resolve, apply, start } from '../src/theme.js'

// matchMedia do jsdom sempre responde matches:false — aqui trocamos por um stub
// controlável para exercitar o caminho 'system'.
function mockSystem(dark) {
  const listeners = []
  vi.stubGlobal('matchMedia', () => ({
    matches: dark,
    addEventListener: (_, fn) => listeners.push(fn),
  }))
  return () => listeners.forEach(fn => fn())
}

describe('theme', () => {
  beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme })

  it('default é sistema, e valor inválido no storage não vaza', () => {
    expect(loadTheme()).toBe('system')
    localStorage.setItem(THEME_KEY, 'neon')
    expect(loadTheme()).toBe('system')
  })

  it('persiste a escolha explícita', () => {
    saveTheme('dark')
    expect(loadTheme()).toBe('dark')
  })

  it('resolve system pelo SO e ignora o SO quando é explícito', () => {
    mockSystem(true)
    expect(resolve('system')).toBe('dark')
    expect(resolve('light')).toBe('light')
    mockSystem(false)
    expect(resolve('system')).toBe('light')
    expect(resolve('dark')).toBe('dark')
  })

  it('apply escreve data-theme no <html>', () => {
    mockSystem(true)
    apply('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    apply('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('start reaplica quando o SO troca, só se a preferência for system', () => {
    let dark = false
    const listeners = []
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return dark },
      addEventListener: (_, fn) => listeners.push(fn),
    }))
    start()
    expect(document.documentElement.dataset.theme).toBe('light')
    dark = true
    listeners.forEach(fn => fn())
    expect(document.documentElement.dataset.theme).toBe('dark')

    saveTheme('light')
    dark = false
    listeners.forEach(fn => fn())
    expect(document.documentElement.dataset.theme).toBe('dark')  // fixo, não segue o SO
  })
})
