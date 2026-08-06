import { execFile } from 'node:child_process'

// Plugins de Claude Code que o kanban sabe instalar por projeto. O usuário liga
// pelas configurações e o kanban roda o mesmo que o `/plugin` do REPL faria —
// `claude plugin marketplace add` seguido de `claude plugin install`.
//
// O escopo é sempre `local`: escreve no .claude/settings.local.json do projeto.
// Um toggle por projeto não deveria mexer no ~/.claude do usuário (valeria para
// toda sessão de Claude Code dele, inclusive fora do kanban), nem entrar no git
// do time via settings.json. E como o worktree copia o .claude/ do projeto, as
// sessões de execução herdam os plugins sem mais nada.
export const PLUGIN_SCOPE = 'local'

// `marketplace` é o repo GitHub que precisa ser registrado antes do install.
// `plugin` é o nome do plugin dentro dele — o id completo (plugin@marketplace)
// é resolvido em runtime contra o catálogo do CLI, porque o nome do marketplace
// vem do manifesto do repo e nem sempre é igual ao nome do repositório.
export const PLUGIN_CATALOG = [
  {
    key: 'ponytail',
    label: 'Ponytail',
    marketplace: 'DietrichGebert/ponytail',
    plugin: 'ponytail',
    description: 'Força a solução mais simples que resolve: YAGNI, stdlib primeiro, sem abstração não pedida.',
    tokenImpact: 'down',
    tokenNote: 'Tende a reduzir tokens de saída — as sessões produzem menos código.',
  },
  {
    key: 'claude-mem',
    label: 'claude-mem',
    marketplace: 'thedotmack/claude-mem',
    plugin: 'claude-mem',
    description: 'Memória persistente entre sessões: comprime o que aconteceu e reinjeta o contexto relevante depois.',
    tokenImpact: 'up',
    tokenNote: 'Aumenta o custo de toda execução: injeta contexto de sessões anteriores em cada run.',
  },
  {
    key: 'obsidian-second-brain',
    label: 'Obsidian Second Brain',
    marketplace: 'eugeniughelbur/obsidian-second-brain',
    plugin: 'obsidian-second-brain',
    description: 'Memória em markdown dentro de um vault do Obsidian, com busca semântica e notas que se reescrevem.',
    tokenImpact: 'up',
    tokenNote: 'Aumenta o custo de toda execução: são ~45 comandos carregados em cada sessão.',
  },
]

export const PLUGIN_KEYS = PLUGIN_CATALOG.map(p => p.key)
export const findPlugin = key => PLUGIN_CATALOG.find(p => p.key === key) || null

const CLI_TIMEOUT_MS = 3 * 60 * 1000

// Instalar plugin baixa um repositório: pode demorar e pode falhar de várias
// formas. Nunca rejeita — devolve { ok, stdout, stderr } para o caller montar
// uma mensagem útil em vez de estourar a rota.
export function runClaude(args, { cwd } = {}) {
  return new Promise(resolve => {
    execFile('claude', args, { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err?.message ?? '')),
      }))
  })
}

// `marketplace add` de um source já registrado devolve erro em vez de no-op.
// Como a operação é declarativa do nosso lado ("garanta que está lá"), isso não
// é falha — só não temos como distinguir a não ser pela mensagem.
const ALREADY_ADDED = /already (exists|added|configured|registered)/i

export async function ensureMarketplace(source, { cwd } = {}) {
  const res = await runClaude(['plugin', 'marketplace', 'add', source, '--scope', PLUGIN_SCOPE], { cwd })
  if (res.ok || ALREADY_ADDED.test(res.stderr + res.stdout)) return { ok: true }
  return { ok: false, error: `falha ao registrar o marketplace ${source}: ${lastLine(res.stderr)}` }
}

// Estado real do CLI, não o que o projeto pediu: { installed: [ids], available: [{name, pluginId}] }.
export async function readPluginState({ cwd } = {}) {
  const res = await runClaude(['plugin', 'list', '--available', '--json'], { cwd })
  if (!res.ok) return { installed: [], available: [] }
  try {
    const d = JSON.parse(res.stdout)
    return {
      installed: Array.isArray(d.installed) ? d.installed : [],
      available: Array.isArray(d.available) ? d.available : [],
    }
  } catch {
    return { installed: [], available: [] }
  }
}

// Resolve o id completo (plugin@marketplace) consultando o catálogo do CLI.
// Chutar o nome do marketplace a partir do nome do repo dá errado em silêncio:
// o install falha com "plugin não encontrado" e o usuário não sabe por quê.
export function resolvePluginId(entry, available) {
  const hit = available.find(a => a.name === entry.plugin)
  return hit?.pluginId || null
}

export const isInstalled = (entry, installed) =>
  installed.some(i => String(i.id || '').split('@')[0] === entry.plugin)

// Traz o projeto para o conjunto de plugins pedido: instala o que falta,
// desinstala o que saiu. Idempotente — rodar de novo com a mesma lista não faz
// nada. Devolve o que mudou e os erros por plugin, sem abortar no primeiro.
export async function syncProjectPlugins(projectPath, wantedKeys) {
  const wanted = PLUGIN_CATALOG.filter(p => wantedKeys.includes(p.key))
  const opts = { cwd: projectPath }
  const installed = []
  const removed = []
  const errors = []

  for (const entry of wanted) {
    const state = await readPluginState(opts)
    if (isInstalled(entry, state.installed)) continue

    const mkt = await ensureMarketplace(entry.marketplace, opts)
    if (!mkt.ok) { errors.push({ key: entry.key, error: mkt.error }); continue }

    // Relê depois do marketplace add: é ele que traz o plugin para o catálogo.
    const id = resolvePluginId(entry, (await readPluginState(opts)).available)
    if (!id) {
      errors.push({ key: entry.key, error: `plugin "${entry.plugin}" não encontrado no marketplace ${entry.marketplace}` })
      continue
    }

    const res = await runClaude(['plugin', 'install', id, '--scope', PLUGIN_SCOPE], opts)
    if (res.ok) installed.push(entry.key)
    else errors.push({ key: entry.key, error: `falha ao instalar ${id}: ${lastLine(res.stderr)}` })
  }

  const state = await readPluginState(opts)
  for (const entry of PLUGIN_CATALOG) {
    if (wantedKeys.includes(entry.key)) continue
    if (!isInstalled(entry, state.installed)) continue
    const id = resolvePluginId(entry, state.available) || entry.plugin
    const res = await runClaude(['plugin', 'uninstall', id, '--scope', PLUGIN_SCOPE, '--yes'], opts)
    if (res.ok) removed.push(entry.key)
    else errors.push({ key: entry.key, error: `falha ao desinstalar ${id}: ${lastLine(res.stderr)}` })
  }

  return { installed, removed, errors }
}

// Catálogo + estado real, para a UI mostrar quando o que está salvo no projeto
// divergiu do que de fato está instalado (install que falhou, plugin removido
// por fora, projeto restaurado em outra máquina).
export async function pluginsView(project) {
  const enabled = normalizeKeys(project.plugins)
  const state = await readPluginState({ cwd: project.path })
  return {
    scope: PLUGIN_SCOPE,
    plugins: PLUGIN_CATALOG.map(entry => ({
      key: entry.key,
      label: entry.label,
      description: entry.description,
      marketplace: entry.marketplace,
      tokenImpact: entry.tokenImpact,
      tokenNote: entry.tokenNote,
      enabled: enabled.includes(entry.key),
      installed: isInstalled(entry, state.installed),
    })),
  }
}

export function normalizeKeys(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(k => PLUGIN_KEYS.includes(k)))]
}

const lastLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || 'erro desconhecido'
