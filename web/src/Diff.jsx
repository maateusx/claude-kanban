import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import { t } from './i18n.js'

// Parser de unified diff: quebra em arquivos e hunks para renderizar estilo PR.
function parseDiff(text) {
  const files = []
  let file = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { header: line, oldPath: null, newPath: null, lines: [], additions: 0, deletions: 0, binary: false }
      files.push(file)
      continue
    }
    if (!file) continue
    if (line.startsWith('--- ')) { file.oldPath = line.slice(4).replace(/^a\//, ''); continue }
    if (line.startsWith('+++ ')) { file.newPath = line.slice(4).replace(/^b\//, ''); continue }
    if (line.startsWith('Binary files ')) { file.binary = true; continue }
    if (/^(index |old mode|new mode|new file mode|deleted file mode|similarity|rename |copy )/.test(line)) continue
    if (line.startsWith('@@')) { file.lines.push({ type: 'hunk', text: line }); continue }
    if (line.startsWith('+')) { file.additions++; file.lines.push({ type: 'add', text: line }); continue }
    if (line.startsWith('-')) { file.deletions++; file.lines.push({ type: 'del', text: line }); continue }
    file.lines.push({ type: 'ctx', text: line })
  }
  for (const f of files) {
    f.path = f.newPath && f.newPath !== '/dev/null' ? f.newPath : (f.oldPath || f.header.replace(/^diff --git a\/(.*) b\/.*$/, '$1'))
    f.status = f.oldPath === '/dev/null' ? 'added' : (f.newPath === '/dev/null' ? 'deleted' : 'modified')
  }
  return files
}

const LINE_STYLE = {
  hunk: 'bg-subtle text-muted',
  add: 'bg-success/10 text-success',
  del: 'bg-danger/10 text-danger',
  ctx: 'text-ink-2',
}
const STATUS_BADGE = {
  added: ['A', 'bg-chip text-success'],
  deleted: ['D', 'bg-chip text-danger'],
  modified: ['M', 'bg-chip text-warning'],
}

function FileDiff({ file }) {
  const [open, setOpen] = useState(true)
  const [badge, badgeCls] = STATUS_BADGE[file.status]
  return (
    <div className="overflow-hidden rounded-[8px] border border-line">
      <button onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 bg-subtle px-3 py-2 text-left text-meta hover:bg-hover">
        <span className="text-muted">{open ? '▾' : '▸'}</span>
        <span className={`rounded px-1 font-bold ${badgeCls}`}>{badge}</span>
        <span className="flex-1 truncate font-mono text-ink">{file.path}</span>
        <span className="shrink-0 font-mono">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto font-mono text-meta leading-5">
          {file.binary
            ? <div className="px-3 py-2 text-muted">{t('arquivo binário')}</div>
            : file.lines.map((l, i) => (
                <div key={i} className={`whitespace-pre px-3 ${LINE_STYLE[l.type]}`}>{l.text || ' '}</div>
              ))}
        </div>
      )}
    </div>
  )
}

export function DiffDrawer({ projectId, task, onClose, onResolved }) {
  const [state, setState] = useState({ loading: true, error: null, files: [] })
  const [action, setAction] = useState(null)      // 'approve' | 'discard' enquanto roda
  const [actionError, setActionError] = useState(null)
  useEffect(() => {
    let alive = true
    api.taskDiff(projectId, task.id)
      .then(d => alive && setState({ loading: false, error: null, files: parseDiff(d.diff) }))
      .catch(e => alive && setState({ loading: false, error: e.message, files: [] }))
    return () => { alive = false }
  }, [projectId, task.id])

  const additions = state.files.reduce((n, f) => n + f.additions, 0)
  const deletions = state.files.reduce((n, f) => n + f.deletions, 0)
  const branch = task.run?.branch

  const run = (kind, confirmMsg, call) => {
    if (action) return
    if (!confirm(confirmMsg)) return
    setActionError(null)
    setAction(kind)
    call()
      .then(res => onResolved?.(kind, res))
      .catch(e => { setActionError(e.message); setAction(null) })
  }
  const approve = () => run('approve',
    t('Mergear "{branch}" na branch principal e arquivar a task?', { branch }),
    () => api.approveTask(projectId, task.id))
  const discard = () => run('discard',
    t('Descartar o trabalho da task? A branch "{branch}" e o diff serão apagados. Isso não tem volta.', { branch }),
    () => api.discardTask(projectId, task.id))

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[720px] max-w-full flex-col border-l border-line bg-bg">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="text-body font-semibold">Diff — {task.title}</span>
        {task.run?.branch && <code className="rounded-[6px] bg-chip px-1.5 py-0.5 text-meta font-mono text-chip-ink">{task.run.branch}</code>}
        <div className="flex-1" />
        {!state.loading && !state.error && (
          <span className="font-mono text-meta">
            {t('{n} arquivo(s)', { n: state.files.length })} ·{' '}
            <span className="text-success">+{additions}</span>{' '}
            <span className="text-danger">−{deletions}</span>
          </span>
        )}
        <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {state.loading && <div className="text-body text-muted">{t('Carregando diff…')}</div>}
        {state.error && <div className="text-body text-danger">{state.error}</div>}
        {state.files.map((f, i) => <FileDiff key={i} file={f} />)}
      </div>
      {branch && (
        <div className="border-t border-line px-4 py-3">
          {actionError && <div className="mb-2 whitespace-pre-wrap text-meta text-danger">{actionError}</div>}
          <div className="flex items-center gap-2">
            <button onClick={discard} disabled={!!action}
              className="rounded-[6px] border border-line px-3 py-1.5 text-meta text-danger hover:bg-hover disabled:opacity-40">
              {action === 'discard' ? t('Descartando…') : t('Descartar')}
            </button>
            <div className="flex-1" />
            <button onClick={approve} disabled={!!action}
              className="rounded-[6px] bg-accent px-3 py-1.5 text-meta font-medium text-white hover:bg-accent-hover disabled:opacity-40">
              {action === 'approve' ? t('Mergeando…') : t('Aprovar (merge)')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
