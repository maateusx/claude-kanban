// Idioma da UI. Mesma política do tema (theme.js): é preferência de UI, então
// vive no localStorage. Cada idioma é um JSON plano em languages/ — adicionar
// um novo é copiar o arquivo, traduzir e listar em LANGS.
//
// t() é lida em tempo de render, então todo texto precisa sair de dentro de um
// componente (ou de uma função chamada no render) — constantes de módulo com
// label traduzido ficariam congeladas no idioma inicial.

import ptBR from './languages/pt-br.json'
import en from './languages/en.json'

export const LANG_KEY = 'ck.lang'

// ponytail: default fixo em pt-BR em vez de ler navigator.language — o app
// nasceu em português e a detecção deixaria a UI (e os testes) dependentes do
// locale da máquina. Se um dia importar, detecte aqui.
export const DEFAULT_LANG = 'pt-BR'

const DICTS = { 'pt-BR': ptBR, en }

export const LANGS = Object.keys(DICTS).map(key => ({ key, label: DICTS[key]['lang.name'] }))

let current = DEFAULT_LANG

export function loadLang() {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return DICTS[v] ? v : DEFAULT_LANG
  } catch { return DEFAULT_LANG }
}

export function saveLang(v) {
  try { localStorage.setItem(LANG_KEY, v) } catch { /* storage indisponível */ }
}

// Aplica o idioma ao módulo e ao <html lang>. O re-render de quem já está na
// tela é responsabilidade de quem chama (o App guarda o idioma em estado).
export function applyLang(v) {
  current = DICTS[v] ? v : DEFAULT_LANG
  try { document.documentElement.lang = current } catch { /* sem DOM */ }
}

// Locale para Intl (datas, ordenação alfabética).
export const locale = () => current

// Traduz uma chave. Chave ausente cai no idioma default e, no limite, na própria
// chave — nunca quebra a tela por causa de tradução faltando.
// Interpolação: "{n} tasks" + { n: 3 }.
export function t(key, vars) {
  const s = DICTS[current]?.[key] ?? DICTS[DEFAULT_LANG][key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m))
}

// Plural simples: usa <key>.one quando n === 1, <key>.other caso contrário.
// Cobre pt-BR e en; idiomas com mais formas plurais vão precisar de mais que isso.
export const tn = (key, n, vars) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...vars })
