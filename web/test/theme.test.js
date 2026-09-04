import { describe, it, expect, beforeEach, vi } from 'vitest'
import { THEME_KEY, MODES, loadTheme, saveTheme, applyTheme, resolvedTheme, initTheme } from '../src/theme.js'

// matchMedia do jsdom sempre responde matches:false — aqui trocamos por um stub
// controlável para exercitar o caminho 'system'.
const mockSystem = dark => vi.stubGlobal('matchMedia', () => ({ matches: dark }))

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
  })

  it('default é sistema, e valor inválido no storage não vaza', () => {
    expect(loadTheme()).toBe('system')
    localStorage.setItem(THEME_KEY, 'neon')
    expect(loadTheme()).toBe('system')
  })

  it('persiste e relê os modos válidos', () => {
    for (const mode of MODES) {
      saveTheme(mode)
      expect(localStorage.getItem(THEME_KEY)).toBe(mode)
      expect(loadTheme()).toBe(mode)
    }
  })

  it('applyTheme escreve data-theme, e "system" tira o atributo para o CSS decidir', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('resolvedTheme só consulta o SO quando o modo é "system"', () => {
    mockSystem(true)
    expect(resolvedTheme('system')).toBe('dark')
    expect(resolvedTheme('light')).toBe('light')
    mockSystem(false)
    expect(resolvedTheme('system')).toBe('light')
  })

  it('resolvedTheme sem matchMedia cai no claro em vez de estourar', () => {
    vi.stubGlobal('matchMedia', () => { throw new Error('sem suporte') })
    expect(resolvedTheme('system')).toBe('light')
  })

  it('initTheme aplica o que estava salvo', () => {
    saveTheme('dark')
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
