const j = r => {
  if (!r.ok) return r.json().then(b => { throw new Error(b.error || r.statusText) })
  return r.json()
}
const opts = body => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

export const api = {
  health: () => fetch('/api/health').then(j),
  usage: () => fetch('/api/usage').then(j),
  projects: () => fetch('/api/projects').then(j),
  addProject: (name, path) => fetch('/api/projects', opts({ name, path })).then(j),
  pickFolder: () => fetch('/api/pick-folder', opts({})).then(j),
  patchProject: (id, patch) => fetch(`/api/projects/${id}`, { ...opts(patch), method: 'PATCH' }).then(j),
  rebootstrap: id => fetch(`/api/projects/${id}/bootstrap`, opts({})).then(j),
  launchDevServer: id => fetch(`/api/projects/${id}/dev-server/launch`, opts({})).then(j),
  stopDevServer: id => fetch(`/api/projects/${id}/dev-server/stop`, opts({})).then(j),
  removeProject: (id, uninstall) => fetch(`/api/projects/${id}?uninstallGuardrails=${!!uninstall}`, { method: 'DELETE' }).then(j),
  branches: (pid, doFetch) => fetch(`/api/projects/${pid}/branches${doFetch ? '?fetch=true' : ''}`).then(j),
  checkoutBranch: (pid, branch, stash) => fetch(`/api/projects/${pid}/branch`, opts({ branch, stash })).then(async r => {
    const b = await r.json().catch(() => ({}))
    if (!r.ok) { const e = new Error(b.error || r.statusText); e.canStash = b.canStash; throw e }
    return b
  }),
  tasks: pid => fetch(`/api/projects/${pid}/tasks`).then(j),
  addTask: (pid, data) => fetch(`/api/projects/${pid}/tasks`, opts(data)).then(j),
  patchTask: (pid, tid, patch) => fetch(`/api/projects/${pid}/tasks/${tid}`, { ...opts(patch), method: 'PATCH' }).then(j),
  archiveTask: (pid, tid) => fetch(`/api/projects/${pid}/tasks/${tid}`, { method: 'DELETE' }).then(j),
  taskDiff: (pid, tid) => fetch(`/api/projects/${pid}/tasks/${tid}/diff`).then(j),
  taskLog: (pid, tid) => fetch(`/api/projects/${pid}/tasks/${tid}/log`).then(j),
  claudeConfig: pid => fetch(`/api/projects/${pid}/claude-config`).then(j),
  claudeConfigFile: (pid, path) => fetch(`/api/projects/${pid}/claude-config/file?path=${encodeURIComponent(path)}`).then(j),
  saveClaudeConfigFile: (pid, path, content) => fetch(`/api/projects/${pid}/claude-config/file`, { ...opts({ path, content }), method: 'PUT' }).then(j),
  suggestionTypes: () => fetch('/api/suggestion-types').then(j),
  analyze: (pid, types) => fetch(`/api/projects/${pid}/analyze`, opts({ types })).then(j),
  pending: pid => fetch(`/api/projects/${pid}/pending-actions`).then(j),
  resolvePending: (pid, aid) => fetch(`/api/projects/${pid}/pending-actions/${aid}/resolve`, opts({})).then(j),
  run: (pid, tid) => fetch(`/api/projects/${pid}/tasks/${tid}/run`, opts({})).then(j),
  kill: taskId => fetch('/api/run/kill', opts(taskId ? { taskId } : {})).then(j),
  queue: () => fetch('/api/run/queue').then(j),
  setConcurrency: max => fetch('/api/run/concurrency', opts({ max })).then(j),
  reorderQueue: taskIds => fetch('/api/run/queue/reorder', opts({ taskIds })).then(j),
}

export function connectWS(onEvent) {
  let ws, closed = false
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/ws`)
    ws.onmessage = e => { try { onEvent(JSON.parse(e.data)) } catch {} }
    ws.onclose = () => { if (!closed) setTimeout(open, 1500) }
  }
  open()
  return () => { closed = true; ws?.close() }
}
