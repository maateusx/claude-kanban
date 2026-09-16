import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import { t } from './i18n.js'

// Cadastro das fontes de busca do projeto (endpoints HTTP que viram tasks).
// Espelha o modelo do server (lib/searchSources.js): method/url/headers/query/body
// + o mapeamento da resposta JSON usado pelo fetch (lib/searchFetch.js).

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const BODY_TYPES = ['json', 'text', 'form']
// GET/DELETE não mandam corpo (buildRequest ignora), então o form também esconde.
const HAS_BODY = m => m !== 'GET' && m !== 'DELETE'

const BLANK = {
  name: '', method: 'GET', url: '',
  headers: [], queryParams: [], body: '', bodyType: 'json', enabled: true,
  resultsPath: '', titleField: '', descriptionField: '', pollMinutes: 0,
}

const input = 'w-full rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent'

function Pairs({ label, rows, onChange }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-meta text-muted">{label}</span>
        <button type="button" aria-label={t('adicionar {label}', { label })}
          onClick={() => onChange([...rows, { key: '', value: '' }])}
          className="text-meta text-accent hover:underline">{t('+ adicionar')}</button>
      </div>
      {rows.length === 0 && <div className="text-meta text-muted">{t('nenhum')}</div>}
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex items-center gap-2">
          <input value={r.key} onChange={e => set(i, { key: e.target.value })}
            aria-label={t('{label} chave {i}', { label, i: i + 1 })} placeholder={t('chave')} className={`${input} font-mono`} />
          <input value={r.value} onChange={e => set(i, { value: e.target.value })}
            aria-label={t('{label} valor {i}', { label, i: i + 1 })} placeholder={t('valor')} className={`${input} font-mono`} />
          <button type="button" aria-label={t('remover {label} {i}', { label, i: i + 1 })}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="text-muted hover:text-danger">✕</button>
        </div>
      ))}
    </div>
  )
}

function SourceForm({ source, busy, onSave, onCancel }) {
  const [s, setS] = useState({ ...BLANK, ...source })
  const set = patch => setS(v => ({ ...v, ...patch }))
  return (
    <form className="space-y-3 rounded-[8px] border border-accent p-3"
      onSubmit={e => { e.preventDefault(); onSave(s) }}>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-meta text-muted">{t('Nome')}</span>
          <input value={s.name} onChange={e => set({ name: e.target.value })} className={input} />
        </label>
        <label>
          <span className="text-meta text-muted">{t('Método')}</span>
          <select value={s.method} onChange={e => set({ method: e.target.value })}
            className="block rounded-[6px] border border-line px-2 py-1 text-body outline-none">
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-meta text-muted">URL</span>
        <input value={s.url} onChange={e => set({ url: e.target.value })}
          placeholder="https://api.exemplo.com/busca" className={`${input} font-mono`} />
      </label>

      <Pairs label="Headers" rows={s.headers} onChange={headers => set({ headers })} />
      <Pairs label="Query params" rows={s.queryParams} onChange={queryParams => set({ queryParams })} />

      {HAS_BODY(s.method) && (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-meta text-muted">Body</span>
            <select value={s.bodyType} onChange={e => set({ bodyType: e.target.value })} aria-label={t('Tipo do body')}
              className="rounded-[6px] border border-line px-1 py-0.5 text-meta outline-none">
              {BODY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <textarea value={s.body} rows={3} onChange={e => set({ body: e.target.value })} aria-label="Body"
            className={`${input} resize-y font-mono`} />
        </div>
      )}

      <div className="flex gap-2">
        {[['resultsPath', t('Caminho dos resultados'), 'data.items'],
          ['titleField', t('Campo do título'), 'title'],
          ['descriptionField', t('Campo da descrição'), 'body']].map(([k, label, ph]) => (
          <label key={k} className="flex-1">
            <span className="text-meta text-muted">{label}</span>
            <input value={s[k]} onChange={e => set({ [k]: e.target.value })} placeholder={ph}
              className={`${input} font-mono`} />
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={s.enabled} onChange={e => set({ enabled: e.target.checked })}
            className="accent-[var(--color-accent)]" />
          {t('Ativa')}
        </label>
        <label className="flex items-center gap-2 text-meta text-muted"
          title={t('O autopilot busca sozinho a cada N minutos e importa o que for novo. 0 = só busca manual.')}>
          {t('Buscar sozinho a cada')}
          <input type="number" min={0} max={10080} value={s.pollMinutes ?? 0} aria-label={t('Intervalo de busca automática (min)')}
            onChange={e => set({ pollMinutes: e.target.value === '' ? 0 : Number(e.target.value) })}
            className="w-16 rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent" />
          min
        </label>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-[6px] px-3 py-1.5 text-body text-ink-2 hover:bg-hover">{t('Cancelar')}</button>
        <button type="submit" disabled={busy}
          className="rounded-[6px] bg-accent px-3 py-1.5 text-body text-white disabled:opacity-50">
          {busy ? t('salvando…') : t('Salvar')}
        </button>
      </div>
    </form>
  )
}

export function SearchSourcesModal({ project, onClose }) {
  const [sources, setSources] = useState(null)   // null = carregando
  const [editing, setEditing] = useState(null)   // null | 'new' | sourceId
  const [confirmId, setConfirmId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = () => api.searchSources(project.id).then(d => setSources(d.searchSources))
    .catch(e => { setError(e.message); setSources([]) })
  useEffect(() => { load() }, [project.id])

  // Toda mutação recarrega a lista: o server é a fonte da verdade (ele normaliza
  // o source antes de salvar) e a resposta do PATCH/DELETE não traz a lista.
  const act = fn => {
    setBusy(true); setError(null)
    return fn()
      .then(() => load().then(() => setEditing(null)))
      .catch(e => setError(e.message))
      .finally(() => setBusy(false))
  }

  const save = s => act(() => (editing === 'new'
    ? api.addSearchSource(project.id, s)
    : api.patchSearchSource(project.id, editing, s)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-[8px] border border-line bg-bg p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('Fontes de busca')} — {project.name}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-body text-danger">{error}</div>}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {sources === null && <div className="text-body text-muted">{t('carregando…')}</div>}
          {sources?.length === 0 && editing !== 'new' &&
            <div className="text-body text-muted">{t('Nenhuma fonte cadastrada.')}</div>}

          {(sources || []).map(s => (editing === s.id ? (
            <SourceForm key={s.id} source={s} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <div key={s.id} className="flex items-center gap-3 rounded-[8px] border border-line p-3 text-body">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="rounded-[4px] border border-line px-1 font-mono text-meta text-muted">{s.method}</span>
                  {!s.enabled && <span className="text-meta text-muted">{t('inativa')}</span>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-meta text-muted">{s.url}</span>
              </span>
              <button onClick={() => act(() => api.patchSearchSource(project.id, s.id, { enabled: !s.enabled }))}
                disabled={busy} className="text-meta text-accent hover:underline">
                {s.enabled ? t('desativar') : t('ativar')}
              </button>
              <button onClick={() => { setEditing(s.id); setConfirmId(null) }} className="text-meta text-accent hover:underline">
                {t('editar')}
              </button>
              {confirmId === s.id ? (
                <button onClick={() => act(() => api.removeSearchSource(project.id, s.id))} disabled={busy}
                  className="text-meta text-danger hover:underline">{t('confirmar')}</button>
              ) : (
                <button onClick={() => setConfirmId(s.id)} className="text-meta text-muted hover:text-danger">
                  {t('remover')}
                </button>
              )}
            </div>
          )))}

          {editing === 'new' && <SourceForm busy={busy} onSave={save} onCancel={() => setEditing(null)} />}
        </div>

        {editing !== 'new' && (
          <div className="mt-3 flex justify-end">
            <button onClick={() => { setEditing('new'); setConfirmId(null) }}
              className="rounded-[6px] border border-line px-3 py-1.5 text-body text-ink-2 hover:bg-hover">
              {t('Nova fonte +')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Busca nas fontes cadastradas e importa os resultados como tasks. Mesmo contrato
// do import de issues do GitHub: `already_imported` vem do server (dedupe por tag
// `search:<sourceId>:<hash>`), e item já importado aparece desabilitado.
export function SearchTasksModal({ project, onClose, onImported }) {
  const [sources, setSources] = useState(null)  // null = carregando
  const [where, setWhere] = useState('all')     // 'all' | sourceId
  const [result, setResult] = useState(null)    // null = ainda não buscou | { items, errors }
  const [selected, setSelected] = useState({})  // tag -> bool
  const [busy, setBusy] = useState(null)        // null | 'fetching' | 'importing'
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)        // resumo do último import

  useEffect(() => {
    api.searchSources(project.id).then(d => setSources(d.searchSources))
      .catch(e => { setError(e.message); setSources([]) })
  }, [project.id])

  const search = () => {
    setBusy('fetching'); setError(null); setDone(null); setResult(null)
    const p = where === 'all' ? api.fetchAllSearchSources(project.id) : api.fetchSearchSource(project.id, where)
    p.then(d => {
      setResult({ items: d.items || [], errors: d.errors || [] })
      setSelected(Object.fromEntries((d.items || []).filter(i => !i.already_imported).map(i => [i.tag, true])))
    })
      .catch(e => setError(e.message))
      .finally(() => setBusy(null))
  }

  const items = result?.items || []
  const importable = items.filter(i => !i.already_imported)
  const chosen = importable.filter(i => selected[i.tag])

  const doImport = () => {
    setBusy('importing'); setError(null)
    api.importSearchItems(project.id, chosen.map(({ sourceId, sourceName, title, description, url }) =>
      ({ sourceId, sourceName, title, description, url })))
      .then(d => {
        setDone(d)
        // Marca localmente o que acabou de entrar, para a lista refletir o dedupe
        // sem precisar refazer a busca (que bateria de novo no endpoint externo).
        const imported = new Set(chosen.map(i => i.tag))
        setResult(r => ({ ...r, items: r.items.map(i => (imported.has(i.tag) ? { ...i, already_imported: true } : i)) }))
        onImported?.()
      })
      .catch(e => setError(e.message))
      .finally(() => setBusy(null))
  }

  const enabled = (sources || []).filter(s => s.enabled)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-[8px] border border-line bg-bg p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('Buscar tasks')} — {project.name}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-body text-danger">{error}</div>}

        <div className="mb-3 flex items-end gap-2">
          <label className="flex-1">
            <span className="text-meta text-muted">{t('Buscar em')}</span>
            <select value={where} onChange={e => setWhere(e.target.value)} aria-label={t('Buscar em')}
              className="block w-full rounded-[6px] border border-line px-2 py-1 text-body outline-none">
              <option value="all">{t('todas as habilitadas')} ({enabled.length})</option>
              {(sources || []).map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.enabled ? '' : ` (${t('inativa')})`}</option>
              ))}
            </select>
          </label>
          <button onClick={search} disabled={!!busy || sources === null || !sources.length}
            className="rounded-[6px] bg-accent px-3 py-1.5 text-body text-white disabled:opacity-50">
            {busy === 'fetching' ? t('buscando…') : t('Buscar')}
          </button>
        </div>

        {sources?.length === 0 && (
          <div className="text-body text-muted">{t('Nenhuma fonte cadastrada — use "Fontes de busca" para criar uma.')}</div>
        )}

        {result?.errors?.map(e => (
          <div key={e.sourceId} className="mb-2 rounded-[6px] border border-line px-3 py-2 text-meta text-danger">
            {e.sourceName}: {e.error}
          </div>
        ))}

        {done && (
          <div className="mb-2 rounded-[6px] border border-line px-3 py-2 text-body">
            {t('{n} task(s) criada(s) no Backlog', { n: done.created.length })}
            {done.skipped.length > 0 && ` · ${t('{n} ignorada(s) (já existiam)', { n: done.skipped.length })}`}
          </div>
        )}

        {result && (
          <div className="flex items-center pb-2 text-body text-ink-2">
            <span>{t('{n} resultado(s) — {m} importável(is)', { n: items.length, m: importable.length })}</span>
            <div className="flex-1" />
            {importable.length > 0 && (
              <button onClick={() => setSelected(
                Object.fromEntries(importable.map(i => [i.tag, chosen.length < importable.length])))}
                className="text-meta text-accent hover:underline">
                {chosen.length < importable.length ? t('selecionar todos') : t('desmarcar todos')}
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {result && items.length === 0 && !result.errors.length &&
            <div className="text-body text-muted">{t('Nenhum resultado.')}</div>}
          {items.map(i => (
            <label key={i.tag}
              className={`flex items-start gap-3 rounded-[8px] border p-3 text-body ${i.already_imported ? 'cursor-default border-line opacity-50' : `cursor-pointer ${selected[i.tag] ? 'border-accent' : 'border-line opacity-60'}`}`}>
              <input type="checkbox" checked={!!selected[i.tag] && !i.already_imported} disabled={i.already_imported}
                className="mt-1 accent-[var(--color-accent)]"
                onChange={e => setSelected(sel => ({ ...sel, [i.tag]: e.target.checked }))} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.title}</span>
                  <span className="rounded-[4px] border border-line px-1 text-meta text-muted">{i.sourceName}</span>
                  {i.already_imported &&
                    <span className="rounded-[4px] border border-line px-1 text-meta text-muted">{t('já existe')}</span>}
                </span>
                {i.url && <span className="mt-0.5 block truncate font-mono text-meta text-muted">{i.url}</span>}
                {i.description &&
                  <span className="mt-1 block line-clamp-3 whitespace-pre-wrap text-meta text-muted">{i.description}</span>}
              </span>
            </label>
          ))}
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy === 'importing'}
            className="rounded-[6px] px-3 py-1.5 text-body text-ink-2 hover:bg-hover">{t('Fechar')}</button>
          <button onClick={doImport} disabled={!chosen.length || !!busy}
            className="rounded-[6px] bg-accent px-3 py-1.5 text-body text-white disabled:opacity-50">
            {busy === 'importing' ? t('importando…') : t('Importar {n} no Backlog', { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
