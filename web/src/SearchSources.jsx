import React, { useEffect, useState } from 'react'
import { api } from './api.js'

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
  resultsPath: '', titleField: '', descriptionField: '',
}

const input = 'w-full rounded-[6px] border border-line px-2 py-1 text-body outline-none focus:border-accent'

function Pairs({ label, rows, onChange }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-meta text-muted">{label}</span>
        <button type="button" aria-label={`adicionar ${label}`}
          onClick={() => onChange([...rows, { key: '', value: '' }])}
          className="text-meta text-accent hover:underline">+ adicionar</button>
      </div>
      {rows.length === 0 && <div className="text-meta text-muted">nenhum</div>}
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex items-center gap-2">
          <input value={r.key} onChange={e => set(i, { key: e.target.value })}
            aria-label={`${label} chave ${i + 1}`} placeholder="chave" className={`${input} font-mono`} />
          <input value={r.value} onChange={e => set(i, { value: e.target.value })}
            aria-label={`${label} valor ${i + 1}`} placeholder="valor" className={`${input} font-mono`} />
          <button type="button" aria-label={`remover ${label} ${i + 1}`}
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
          <span className="text-meta text-muted">Nome</span>
          <input value={s.name} onChange={e => set({ name: e.target.value })} className={input} />
        </label>
        <label>
          <span className="text-meta text-muted">Método</span>
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
            <select value={s.bodyType} onChange={e => set({ bodyType: e.target.value })} aria-label="Tipo do body"
              className="rounded-[6px] border border-line px-1 py-0.5 text-meta outline-none">
              {BODY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <textarea value={s.body} rows={3} onChange={e => set({ body: e.target.value })} aria-label="Body"
            className={`${input} resize-y font-mono`} />
        </div>
      )}

      <div className="flex gap-2">
        {[['resultsPath', 'Caminho dos resultados', 'data.items'],
          ['titleField', 'Campo do título', 'title'],
          ['descriptionField', 'Campo da descrição', 'body']].map(([k, label, ph]) => (
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
          Ativa
        </label>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-[6px] px-3 py-1.5 text-body text-ink-2 hover:bg-hover">Cancelar</button>
        <button type="submit" disabled={busy}
          className="rounded-[6px] bg-accent px-3 py-1.5 text-body text-white disabled:opacity-50">
          {busy ? 'salvando…' : 'Salvar'}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/10 p-4"
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-[8px] border border-line bg-bg p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Fontes de busca — {project.name}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        {error && <div className="mb-3 rounded-[6px] border border-line px-3 py-2 text-body text-danger">{error}</div>}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {sources === null && <div className="text-body text-muted">carregando…</div>}
          {sources?.length === 0 && editing !== 'new' &&
            <div className="text-body text-muted">Nenhuma fonte cadastrada.</div>}

          {(sources || []).map(s => (editing === s.id ? (
            <SourceForm key={s.id} source={s} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <div key={s.id} className="flex items-center gap-3 rounded-[8px] border border-line p-3 text-body">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="rounded-[4px] border border-line px-1 font-mono text-meta text-muted">{s.method}</span>
                  {!s.enabled && <span className="text-meta text-muted">inativa</span>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-meta text-muted">{s.url}</span>
              </span>
              <button onClick={() => act(() => api.patchSearchSource(project.id, s.id, { enabled: !s.enabled }))}
                disabled={busy} className="text-meta text-accent hover:underline">
                {s.enabled ? 'desativar' : 'ativar'}
              </button>
              <button onClick={() => { setEditing(s.id); setConfirmId(null) }} className="text-meta text-accent hover:underline">
                editar
              </button>
              {confirmId === s.id ? (
                <button onClick={() => act(() => api.removeSearchSource(project.id, s.id))} disabled={busy}
                  className="text-meta text-danger hover:underline">confirmar</button>
              ) : (
                <button onClick={() => setConfirmId(s.id)} className="text-meta text-muted hover:text-danger">
                  remover
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
              Nova fonte +
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
