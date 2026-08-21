import { findTask } from './tasks.js'

// Webhook de saída: avisa um endpoint externo (Slack, n8n, Zapier, o que for)
// nos dois casos em que ninguém pode ficar esperando o board estar aberto —
// o run precisa de um humano ou o run falhou. O resto continua só no WS.

const TIMEOUT_MS = 10_000

export function webhookUrl(project) {
  const u = String(project?.webhookUrl || '').trim()
  // http(s) só: o fetch aceitaria file:/data: e não queremos isso vindo de config.
  return /^https?:\/\//i.test(u) ? u : null
}

// Puro: traduz um evento do emit() em bodies de webhook. `seen` são os ids de
// pending-actions já enviados — o watcher reemite a lista inteira a cada change,
// então sem isso toda ação pendente antiga seria reenviada.
export function webhookEventsFor(evt, seen = new Set()) {
  switch (evt.type) {
    case 'run.finished':
      if (evt.humanRequest) return [{ event: 'human_request', taskId: evt.taskId }]
      // verifyFailed vem com exitCode 0 (o run passou, a verificação é que não).
      if (evt.exitCode !== 0 || evt.verifyFailed) {
        return [{ event: 'run_failed', taskId: evt.taskId, exitCode: evt.exitCode, verifyFailed: !!evt.verifyFailed }]
      }
      return []
    case 'pending.updated':
      return (evt.actions || [])
        .filter(a => a.status === 'pending' && !seen.has(a.id))
        .map(a => ({ event: 'pending_action', taskId: a.taskId || null, actionId: a.id, label: a.label, command: a.command }))
    default:
      return []
  }
}

// Fire-and-forget: um endpoint fora do ar não pode travar nem derrubar o run.
export async function postWebhook(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) console.error(`webhook ${url} respondeu ${res.status}`)
  } catch (e) {
    console.error(`webhook ${url} falhou: ${e.message}`)
  }
}

// Cola o mapeamento puro no envio: resolve a URL, marca os ids já enviados e
// enriquece o body com o que o emit() não carrega (nome do projeto, título).
export function notifyWebhook(project, evt, seen) {
  const url = webhookUrl(project)
  if (!url) return
  for (const e of webhookEventsFor(evt, seen)) {
    if (e.actionId) seen.add(e.actionId)
    let taskTitle = null
    if (e.taskId) { try { taskTitle = findTask(project.path, e.taskId)?.title || null } catch {} }
    postWebhook(url, { ...e, projectId: project.id, project: project.name, taskTitle, at: new Date().toISOString() })
  }
}
