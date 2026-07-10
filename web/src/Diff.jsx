import React, { useEffect, useState } from 'react'
import { api } from './api.js'

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
  hunk: 'bg-sky-950/40 text-sky-400',
  add: 'bg-emerald-950/50 text-emerald-300',
  del: 'bg-red-950/50 text-red-300',
  ctx: 'text-zinc-400',
}
const STATUS_BADGE = {
  added: ['A', 'bg-emerald-900 text-emerald-300'],
  deleted: ['D', 'bg-red-900 text-red-300'],
  modified: ['M', 'bg-amber-900 text-amber-300'],
}

function FileDiff({ file }) {
  const [open, setOpen] = useState(true)
  const [badge, badgeCls] = STATUS_BADGE[file.status]
  return (
    <div className="overflow-hidden rounded-md border border-zinc-800">
      <button onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 bg-zinc-900 px-3 py-2 text-left text-xs hover:bg-zinc-800/70">
        <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
        <span className={`rounded px-1 font-bold ${badgeCls}`}>{badge}</span>
        <span className="flex-1 truncate font-mono text-zinc-200">{file.path}</span>
        <span className="shrink-0 font-mono">
          <span className="text-emerald-400">+{file.additions}</span>{' '}
          <span className="text-red-400">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto bg-zinc-950 font-mono text-xs leading-5">
          {file.binary
            ? <div className="px-3 py-2 text-zinc-600">arquivo binário</div>
            : file.lines.map((l, i) => (
                <div key={i} className={`whitespace-pre px-3 ${LINE_STYLE[l.type]}`}>{l.text || ' '}</div>
              ))}
        </div>
      )}
    </div>
  )
}

export function DiffDrawer({ projectId, task, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, files: [] })
  useEffect(() => {
    let alive = true
    api.taskDiff(projectId, task.id)
      .then(d => alive && setState({ loading: false, error: null, files: parseDiff(d.diff) }))
      .catch(e => alive && setState({ loading: false, error: e.message, files: [] }))
    return () => { alive = false }
  }, [projectId, task.id])

  const additions = state.files.reduce((n, f) => n + f.additions, 0)
  const deletions = state.files.reduce((n, f) => n + f.deletions, 0)

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[720px] max-w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <span className="text-sm font-semibold">Diff — {task.title}</span>
        {task.run?.branch && <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-violet-300">{task.run.branch}</code>}
        <div className="flex-1" />
        {!state.loading && !state.error && (
          <span className="font-mono text-xs">
            {state.files.length} arquivo{state.files.length === 1 ? '' : 's'} ·{' '}
            <span className="text-emerald-400">+{additions}</span>{' '}
            <span className="text-red-400">−{deletions}</span>
          </span>
        )}
        <button onClick={onClose} className="text-zinc-500 hover:text-white">✕</button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {state.loading && <div className="text-sm text-zinc-600">Carregando diff…</div>}
        {state.error && <div className="text-sm text-red-400">{state.error}</div>}
        {state.files.map((f, i) => <FileDiff key={i} file={f} />)}
      </div>
    </div>
  )
}
