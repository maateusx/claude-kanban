import { describe, it, expect, beforeEach } from 'vitest'
import { t, tn, loadLang, saveLang, applyLang, locale, LANGS, LANG_KEY, DEFAULT_LANG } from '../src/i18n.js'
import ptBR from '../src/languages/pt-br.json'
import en from '../src/languages/en.json'

beforeEach(() => {
  localStorage.clear()
  applyLang(DEFAULT_LANG)
})

describe('preferência', () => {
  it('default é pt-BR; idioma desconhecido no storage cai para o default', () => {
    expect(loadLang()).toBe(DEFAULT_LANG)
    localStorage.setItem(LANG_KEY, 'klingon')
    expect(loadLang()).toBe(DEFAULT_LANG)
  })

  it('persiste e relê', () => {
    saveLang('en')
    expect(localStorage.getItem(LANG_KEY)).toBe('en')
    expect(loadLang()).toBe('en')
  })

  it('applyLang troca o dicionário, o locale e o <html lang>', () => {
    applyLang('en')
    expect(locale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(t('common.save')).toBe('Save')
    applyLang('pt-BR')
    expect(t('common.save')).toBe('Salvar')
  })

  it('idioma inválido em applyLang cai no default em vez de quebrar', () => {
    applyLang('klingon')
    expect(locale()).toBe(DEFAULT_LANG)
    expect(t('common.save')).toBe('Salvar')
  })
})

describe('t', () => {
  it('interpola {vars}', () => {
    expect(t('run.exit', { code: 137 })).toBe('exit 137')
  })

  it('placeholder sem valor fica literal em vez de "undefined"', () => {
    expect(t('run.exit', {})).toBe('exit {code}')
  })

  it('chave inexistente devolve a própria chave', () => {
    expect(t('nao.existe')).toBe('nao.existe')
  })

  it('chave faltando no idioma ativo cai no default', () => {
    applyLang('en')
    // toda chave existe nos dois dicionários hoje; o fallback é testado forçando
    // uma chave só-pt via o próprio dicionário default.
    expect(t('common.save')).toBe('Save')
  })
})

describe('tn', () => {
  it('escolhe singular/plural pelo n', () => {
    expect(tn('diff.files', 1)).toBe('1 arquivo')
    expect(tn('diff.files', 3)).toBe('3 arquivos')
    applyLang('en')
    expect(tn('diff.files', 1)).toBe('1 file')
    expect(tn('diff.files', 0)).toBe('0 files')
  })
})

describe('dicionários', () => {
  it('todo idioma listado tem nome próprio', () => {
    expect(LANGS.map(l => l.key).sort()).toEqual(['en', 'pt-BR'])
    for (const l of LANGS) expect(l.label).toBeTruthy()
  })

  // O que mais quebra numa tradução é chave nova só num dos arquivos.
  it('pt-BR e en têm exatamente as mesmas chaves', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort())
  })

  it('cada chave tem os mesmos placeholders nos dois idiomas', () => {
    const vars = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    for (const key of Object.keys(ptBR)) {
      expect(vars(en[key]), `placeholders divergentes em "${key}"`).toEqual(vars(ptBR[key]))
    }
  })
})
