import React, { useEffect, useState } from 'react'
import { api } from './api.js'

// Tela de extensões do Claude Code: skills, agents, commands, hooks e plugins,
// em dois escopos — global (~/.claude, vale para todos os projetos) e do projeto
// (<projeto>/.claude, versionado com o repo).
//
// Desativar não apaga: skill/agent/command vão para a pasta irmã `<kind>-disabled/`
// (o Claude não varre) e hook sai do settings.json guardado numa gaveta do kanban.

const KINDS = [
  { key: 'skills', label: 'Skills' },
  { key: 'agents', label: 'Agents' },
  { key: 'commands', label: 'Commands' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'plugins', label: 'Plugins' },
]
// O marketplace oficial tem centenas de plugins; a lista mostra os primeiros e
// avisa quantos ficaram de fora em vez de truncar em silêncio.
const MAX_AVAILABLE = 40

const match = (q, ...fields) => !q || fields.some(f => String(f || '').toLowerCase().includes(q.toLowerCase()))

export function ExtensionsDrawer({ project, initialScope = 'global', onClose }) {
  const [scope, setScope] = useState(project ? initialScope : 'global')
  const [kind, setKind] = useState('skills')
  const [query, setQuery] = useState('')
  const [data, setData] = useState(null)
  const [plugins, setPlugins] = useState(null)
  const [pluginErr, setPluginErr] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const pid = scope === 'project' ? project?.id : null

  useEffect(() => {
    setData(null); setError(null)
    api.extensions(pid).then(setData).catch(e => setError(e.message))
  }, [pid])

  const loadPlugins = (refresh = false) => {
    setPlugins(null); setPluginErr(null)
    api.plugins(refresh).then(setPlugins).catch(e => setPluginErr(e.message))
  }
  useEffect(() => { if (kind === 'plugins' && !plugins && !pluginErr) loadPlugins() }, [kind])

  // Toda mutação de extensão devolve a listagem nova; o catálogo só vem no GET.
  const act = (key, fn) => {
    setBusy(key); setError(null)
    return fn()
      .then(r => setData(d => ({ ...d, ...r, catalog: r.catalog || d.catalog })))
      .catch(e => setError(e.message))
      .finally(() => setBusy(null))
  }

  const plugin = (action, id) => {
    setBusy(id); setPluginErr(null)
    return api.pluginAction(pid, action, id)
      .then(() => api.plugins(true).then(setPlugins))
      .catch(e => setPluginErr(e.message))
      .finally(() => setBusy(null))
  }

  const items = (data?.items?.[kind] || []).filter(i => match(query, i.name, i.title, i.description))
  const catalog = (data?.catalog || []).filter(c =>
    c.kind === kind &&
    !(data?.items?.[kind] || []).some(i => i.name === c.name || i.name === c.signature) &&
    match(query, c.name, c.title, c.description))

  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" onMouseDown={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-[900px] max-w-full flex-col border-l border-line bg-bg">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="font-semibold">Extensões do Claude</h2>
          <div className="flex items-center gap-0.5 rounded-[6px] bg-subtle p-0.5 text-meta">
            {[{ key: 'global', label: 'Global (~/.claude)' }, { key: 'project', label: project ? `Projeto · ${project.name}` : 'Projeto' }].map(o => (
              <button key={o.key} onClick={() => setScope(o.key)} disabled={o.key === 'project' && !project}
                title={o.key === 'project' && !project ? 'Selecione um projeto no board para gerenciar as extensões dele' : ''}
                className={`rounded-[4px] px-2.5 py-1 disabled:opacity-40 ${scope === o.key ? 'border border-line bg-bg text-ink' : 'text-ink-2 hover:text-ink'}`}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-5 py-2">
          {KINDS.map(k => (
            <button key={k.key} onClick={() => setKind(k.key)}
              className={`rounded-[6px] px-2.5 py-1 text-meta ${kind === k.key ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:bg-hover'}`}>
              {k.label}
              {k.key !== 'plugins' && data?.items?.[k.key]?.length ? <span className="ml-1 text-muted">{data.items[k.key].length}</span> : null}
            </button>
          ))}
          <div className="flex-1" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar…"
            className="w-56 rounded-[6px] border border-transparent bg-subtle px-3 py-1 text-meta outline-none placeholder:text-muted focus:border-line focus:bg-bg" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-meta text-danger">{error}</div>}
          {data && (
            <div className="mb-3 text-meta text-muted">
              {scope === 'global'
                ? 'Instalado aqui vale para todos os projetos deste computador.'
                : 'Instalado aqui vale só neste projeto e vai junto no repositório (.claude/).'}
              <span className="ml-1 font-mono">{data.root}</span>
            </div>
          )}

          {kind === 'plugins' ? (
            <PluginsPanel plugins={plugins} err={pluginErr} query={query} busy={busy} scope={scope}
              onRefresh={() => loadPlugins(true)} onAction={plugin} />
          ) : !data ? (
            <div className="py-8 text-center text-body text-muted">carregando…</div>
          ) : (
            <>
              <Section title="Instalados">
                {items.length === 0 && <Empty>Nada instalado neste escopo.</Empty>}
                {items.map(i => (
                  <Row key={i.name} title={i.title || i.name} subtitle={i.kind === 'hooks' ? null : i.name} desc={i.description}
                    off={!i.enabled}>
                    <Tag>{i.enabled ? 'ativo' : 'desativado'}</Tag>
                    <Act busy={busy === i.name} onClick={() => act(i.name, () => api.toggleExtension(pid, kind, i.name, !i.enabled))}>
                      {i.enabled ? 'desativar' : 'ativar'}
                    </Act>
                    <Act danger busy={busy === i.name}
                      onClick={() => confirm(`Remover "${i.title || i.name}" de vez?`) && act(i.name, () => api.removeExtension(pid, kind, i.name))}>
                      remover
                    </Act>
                  </Row>
                ))}
              </Section>

              <Section title="Catálogo">
                {catalog.length === 0 && <Empty>Nada novo no catálogo para este tipo.</Empty>}
                {catalog.map(c => (
                  <Row key={c.id} title={c.title} subtitle={c.name} desc={c.description}>
                    <Act primary busy={busy === c.id} onClick={() => act(c.id, () => api.installExtension(pid, c.id))}>instalar</Act>
                  </Row>
                ))}
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function PluginsPanel({ plugins, err, query, busy, scope, onRefresh, onAction }) {
  if (err) return (
    <div className="rounded-[6px] border border-line px-3 py-2 text-meta text-danger">
      {err} <button onClick={onRefresh} className="ml-2 underline">tentar de novo</button>
    </div>
  )
  if (!plugins) return <div className="py-8 text-center text-body text-muted">consultando `claude plugin`…</div>

  const installedIds = new Set(plugins.installed.map(p => p.id))
  const available = plugins.available.filter(p => !installedIds.has(p.id) && match(query, p.name, p.description, p.marketplace))
  const shown = available.slice(0, MAX_AVAILABLE)

  return (
    <>
      <Section title="Instalados" action={<Act busy={false} onClick={onRefresh}>atualizar</Act>}>
        {plugins.installed.length === 0 && <Empty>Nenhum plugin instalado.</Empty>}
        {plugins.installed.map(p => (
          <Row key={p.id + p.scope} title={p.id} subtitle={`v${p.version} · escopo ${p.scope}`} off={!p.enabled}>
            <Tag>{p.enabled ? 'ativo' : 'desativado'}</Tag>
            <Act busy={busy === p.id} onClick={() => onAction(p.enabled ? 'disable' : 'enable', p.id)}>
              {p.enabled ? 'desativar' : 'ativar'}
            </Act>
            <Act danger busy={busy === p.id}
              onClick={() => confirm(`Desinstalar ${p.id}?`) && onAction('uninstall', p.id)}>desinstalar</Act>
          </Row>
        ))}
      </Section>

      <Section title="Marketplace">
        {available.length === 0 && <Empty>Nenhum plugin disponível para essa busca.</Empty>}
        {shown.map(p => (
          <Row key={p.id} title={p.name} subtitle={p.marketplace} desc={p.description}>
            <Act primary busy={busy === p.id} onClick={() => onAction('install', p.id)}>
              instalar {scope === 'project' ? 'no projeto' : 'global'}
            </Act>
          </Row>
        ))}
        {available.length > shown.length && (
          <div className="px-1 py-2 text-meta text-muted">
            mostrando {shown.length} de {available.length} — refine a busca para ver o resto.
          </div>
        )}
      </Section>
    </>
  )
}

const Section = ({ title, action, children }) => (
  <div className="mb-5">
    <div className="mb-1 flex items-center gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="flex-1" />
      {action}
    </div>
    <div className="divide-y divide-line rounded-[8px] border border-line">{children}</div>
  </div>
)

const Empty = ({ children }) => <div className="px-3 py-3 text-meta text-muted">{children}</div>

// subtitle repetindo o title (skill cujo `name` do frontmatter é o próprio nome
// da pasta) vira ruído — some.
const Row = ({ title, subtitle, desc, off, children }) => (
  <div className={`flex items-start gap-3 px-3 py-2.5 ${off ? 'opacity-55' : ''}`}>
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-body font-medium text-ink">{title}</span>
        {subtitle && subtitle !== title && <span className="truncate font-mono text-meta text-muted">{subtitle}</span>}
      </div>
      {desc && <p className="mt-0.5 line-clamp-2 text-meta text-ink-2">{desc}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-1.5">{children}</div>
  </div>
)

const Tag = ({ children }) => <span className="rounded-[4px] bg-subtle px-1.5 py-0.5 text-[10px] text-muted">{children}</span>

const Act = ({ busy, primary, danger, children, ...props }) => (
  <button {...props} disabled={busy}
    className={`rounded-[6px] border px-2 py-1 text-meta disabled:opacity-40 ${
      primary ? 'border-accent text-accent hover:bg-hover'
        : danger ? 'border-line text-danger hover:bg-hover'
          : 'border-line text-ink-2 hover:bg-hover'}`}>
    {busy ? '…' : children}
  </button>
)
