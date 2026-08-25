import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import matter from 'gray-matter'
import { HOME_DIR, readJson, writeJson } from './paths.js'
import { CATALOG, catalogItem } from './catalog.js'

// Gerência de extensões do Claude Code (skills, agents, commands e hooks) em
// dois escopos: global (~/.claude) e por projeto (<projeto>/.claude).
//
// Ativar/desativar: o Claude Code não tem flag de "desativado" para skill/agent/
// command — ele carrega tudo que estiver na pasta. Então desativar move o item
// para uma pasta irmã `<kind>-disabled/`, que o Claude não varre e que deixa o
// estado visível no disco. Hook é entrada de JSON em settings.json: desativar
// tira a entrada de lá e guarda numa "gaveta" nossa (HOME_DIR/disabled-hooks.json),
// para não perder a definição do usuário.

export const globalRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const scopeRoot = projectPath => projectPath ? path.join(projectPath, '.claude') : globalRoot()
const scopeKey = projectPath => projectPath || 'global'

const KINDS = {
  skills: { dir: 'skills', entry: 'SKILL.md' }, // pasta com SKILL.md dentro
  agents: { dir: 'agents', ext: '.md' },
  commands: { dir: 'commands', ext: '.md' },
}
export const KIND_KEYS = [...Object.keys(KINDS), 'hooks']

// Nome vem da UI e vira caminho: só o que não escapa da pasta do kind.
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const checkName = name => {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) throw new Error('nome inválido')
  return name
}
const checkKind = kind => {
  if (!KIND_KEYS.includes(kind)) throw new Error('tipo inválido')
  return kind
}

const dirFor = (root, kind, enabled) => path.join(root, KINDS[kind].dir + (enabled ? '' : '-disabled'))

function metaOf(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').slice(0, 16 * 1024)
    const data = matter(raw).data || {}
    return { title: data.name || null, description: String(data.description || '').slice(0, 400) }
  } catch { return { title: null, description: '' } }
}

function listKind(root, kind) {
  const k = KINDS[kind]
  const out = []
  for (const enabled of [true, false]) {
    const dir = dirFor(root, kind, enabled)
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      let name, file
      if (k.entry) {
        if (!e.isDirectory()) continue
        name = e.name
        file = path.join(dir, name, k.entry)
        if (!fs.existsSync(file)) continue
      } else {
        if (!e.isFile() || path.extname(e.name) !== k.ext) continue
        name = e.name.slice(0, -k.ext.length)
        file = path.join(dir, e.name)
      }
      out.push({ kind, name, enabled, ...metaOf(file), path: path.relative(root, file) })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/* ---------------------------------------------------------------- hooks */

const settingsFile = root => path.join(root, 'settings.json')
const stashFile = () => path.join(HOME_DIR, 'disabled-hooks.json')

// Id estável e único por conteúdo: índice mudaria a cada ativar/desativar e
// matcher sozinho colide quando o usuário tem dois hooks no mesmo evento.
const hookId = (event, entry) =>
  `${event}:${crypto.createHash('sha1').update(JSON.stringify(entry)).digest('hex').slice(0, 8)}`

const hookItem = (event, entry, enabled) => ({
  kind: 'hooks',
  name: hookId(event, entry),
  enabled,
  event,
  title: entry.matcher ? `${event} · ${entry.matcher}` : event,
  description: (entry.hooks || []).map(h => h.command || h.type || '').join(' ; ').slice(0, 400),
})

const readStash = () => readJson(stashFile(), {}) || {}
const stashOf = key => (readStash()[key] || [])
function writeStash(key, list) {
  const all = readStash()
  if (list.length) all[key] = list; else delete all[key]
  writeJson(stashFile(), all)
}

function listHooks(root, projectPath) {
  const s = readJson(settingsFile(root), {}) || {}
  const out = []
  for (const [event, arr] of Object.entries(s.hooks || {})) {
    if (Array.isArray(arr)) for (const entry of arr) out.push(hookItem(event, entry, true))
  }
  for (const { event, entry } of stashOf(scopeKey(projectPath))) out.push(hookItem(event, entry, false))
  return out
}

// Tira a entrada de settings.json (se estiver lá) e devolve {event, entry}.
function pullHook(root, name) {
  const file = settingsFile(root)
  const s = readJson(file, {}) || {}
  for (const [event, arr] of Object.entries(s.hooks || {})) {
    if (!Array.isArray(arr)) continue
    const i = arr.findIndex(entry => hookId(event, entry) === name)
    if (i === -1) continue
    const [entry] = arr.splice(i, 1)
    if (!arr.length) delete s.hooks[event]
    writeJson(file, s)
    return { event, entry }
  }
  return null
}

function pushHook(root, event, entry) {
  const file = settingsFile(root)
  const s = readJson(file, {}) || {}
  s.hooks = s.hooks || {}
  s.hooks[event] = s.hooks[event] || []
  if (!s.hooks[event].some(e => hookId(event, e) === hookId(event, entry))) s.hooks[event].push(entry)
  writeJson(file, s)
}

/* ---------------------------------------------------------------- API */

// Catálogo para a UI, sem o conteúdo dos arquivos. `signature` é o id que o hook
// terá depois de instalado — é assim que a tela sabe que ele já está lá (o nome
// de um hook instalado é hash do conteúdo, não o nome do item de catálogo).
export const catalogView = () => CATALOG.map(({ files, hook, ...c }) => ({
  ...c,
  signature: hook ? hookId(hook.event, hook.entry) : null,
}))

export function listExtensions(projectPath) {
  const root = scopeRoot(projectPath)
  const items = {}
  for (const kind of Object.keys(KINDS)) items[kind] = listKind(root, kind)
  items.hooks = listHooks(root, projectPath)
  return { scope: projectPath ? 'project' : 'global', root, items }
}

export function installExtension(catalogId, projectPath) {
  const item = catalogItem(catalogId)
  if (!item) throw new Error('item de catálogo desconhecido')
  const root = scopeRoot(projectPath)

  if (item.hook) {
    // reinstalar um hook já presente é no-op (pushHook deduplica por conteúdo)
    pushHook(root, item.hook.event, item.hook.entry)
    return { installed: item.id }
  }
  for (const f of item.files) {
    const full = path.join(root, f.rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, f.content)
  }
  // instalar de novo por cima reativa o que estava desativado
  const disabled = path.join(dirFor(root, item.kind, false), KINDS[item.kind].entry ? item.name : item.name + KINDS[item.kind].ext)
  fs.rmSync(disabled, { recursive: true, force: true })
  return { installed: item.id }
}

export function toggleExtension(kind, name, enabled, projectPath) {
  checkKind(kind)
  const root = scopeRoot(projectPath)

  if (kind === 'hooks') {
    const key = scopeKey(projectPath)
    if (enabled) {
      const list = stashOf(key)
      const i = list.findIndex(h => hookId(h.event, h.entry) === name)
      if (i === -1) throw new Error('hook não encontrado')
      const [h] = list.splice(i, 1)
      writeStash(key, list)
      pushHook(root, h.event, h.entry)
    } else {
      const h = pullHook(root, name)
      if (!h) throw new Error('hook não encontrado')
      writeStash(key, [...stashOf(key), h])
    }
    return listExtensions(projectPath)
  }

  checkName(name)
  const k = KINDS[kind]
  const leaf = k.entry ? name : name + k.ext
  const from = path.join(dirFor(root, kind, !enabled), leaf)
  const to = path.join(dirFor(root, kind, enabled), leaf)
  if (!fs.existsSync(from)) throw new Error('item não encontrado')
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  return listExtensions(projectPath)
}

export function removeExtension(kind, name, projectPath) {
  checkKind(kind)
  const root = scopeRoot(projectPath)

  if (kind === 'hooks') {
    const key = scopeKey(projectPath)
    const list = stashOf(key)
    const i = list.findIndex(h => hookId(h.event, h.entry) === name)
    if (i !== -1) { list.splice(i, 1); writeStash(key, list) }
    else if (!pullHook(root, name)) throw new Error('hook não encontrado')
    return listExtensions(projectPath)
  }

  checkName(name)
  const k = KINDS[kind]
  const leaf = k.entry ? name : name + k.ext
  let removed = false
  for (const enabled of [true, false]) {
    const full = path.join(dirFor(root, kind, enabled), leaf)
    if (fs.existsSync(full)) { fs.rmSync(full, { recursive: true, force: true }); removed = true }
  }
  if (!removed) throw new Error('item não encontrado')
  return listExtensions(projectPath)
}
