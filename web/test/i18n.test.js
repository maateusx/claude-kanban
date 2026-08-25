import { describe, it, expect, beforeEach, vi } from 'vitest'
import en from '../src/languages/en.json'
import ptBR from '../src/languages/pt-BR.json'

// O idioma é lido do localStorage na importação do módulo (a troca recarrega a
// página), então cada caso reimporta o i18n com o storage já preparado.
const load = async lang => {
  localStorage.clear()
  if (lang) localStorage.setItem('ck.lang', lang)
  vi.resetModules()
  return import('../src/i18n.js')
}

describe('i18n', () => {
  beforeEach(() => { localStorage.clear() })

  it('os dois arquivos de língua têm exatamente as mesmas chaves', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort())
  })

  it('pt-BR é a identidade: a chave já é o texto em português', () => {
    for (const [k, v] of Object.entries(ptBR)) expect(v).toBe(k)
  })

  it('default é pt-BR e valor inválido no storage não vaza', async () => {
    expect((await load()).getLang()).toBe('pt-BR')
    expect((await load('klingon')).getLang()).toBe('pt-BR')
  })

  it('traduz pela língua escolhida e cai na chave quando não conhece', async () => {
    const { t } = await load('en')
    expect(t('Salvar')).toBe('Save')
    expect(t('string que ninguém traduziu')).toBe('string que ninguém traduziu')
  })

  it('interpola {vars} e deixa passar o que não recebeu valor', async () => {
    const { t } = await load('pt-BR')
    expect(t('Nova task em {col}', { col: 'To Do' })).toBe('Nova task em To Do')
    expect(t('Nova task em {col}')).toBe('Nova task em {col}')
  })

  it('locale acompanha a língua — datas e ordenação seguem junto', async () => {
    expect((await load('en')).locale()).toBe('en')
    expect((await load('pt-BR')).locale()).toBe('pt-BR')
  })

  it('setLang persiste, marca o <html> e recarrega a página', async () => {
    const { setLang } = await load('pt-BR')
    const reload = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ reload })

    setLang('en')
    expect(localStorage.getItem('ck.lang')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(reload).toHaveBeenCalled()

    setLang('klingon')                              // língua inexistente: no-op
    expect(localStorage.getItem('ck.lang')).toBe('en')
    vi.restoreAllMocks()
  })
})
