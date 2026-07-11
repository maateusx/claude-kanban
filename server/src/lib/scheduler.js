import fs from 'node:fs'
import { listTasks, updateTask } from './tasks.js'

// Ticker do agendamento. Duas formas de adiar trabalho:
//   - task.scheduled_at  → a task entra na fila sozinha quando chegar a hora;
//   - project.queuePausedUntil → a fila inteira do projeto fica parada até a hora.
// A granularidade é a do tick: um agendamento nunca dispara antes da hora, mas
// pode disparar até TICK_MS depois. Suficiente para "roda de madrugada".
export const TICK_MS = 20_000

// Normaliza qualquer entrada de data para ISO; null se não for uma data válida.
export function parseWhen(value) {
  const t = Date.parse(value || '')
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export function isFuture(value, now = Date.now()) {
  const t = Date.parse(value || '')
  return !Number.isNaN(t) && t > now
}

// Tasks cujo horário já chegou. Só backlog/todo: uma task em doing/done não
// volta para a fila por agendamento.
export function dueTasks(tasks, now = Date.now()) {
  return tasks.filter(t =>
    t.scheduled_at &&
    !isFuture(t.scheduled_at, now) &&
    ['backlog', 'todo'].includes(t.status) &&
    !(t.tags || []).includes('blocked'))
}

export class Scheduler {
  constructor({ db, saveProjects, runner, emit }) {
    this.db = db
    this.saveProjects = saveProjects
    this.runner = runner
    this.emit = emit
    this.timer = null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.tick()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  tick(now = Date.now()) {
    let unpaused = false
    for (const project of this.db.projects) {
      if (!fs.existsSync(project.path)) continue

      // Pausa vencida: limpa antes de olhar as tasks, para que o que vencer
      // neste mesmo tick já possa rodar.
      if (project.queuePausedUntil && !isFuture(project.queuePausedUntil, now)) {
        project.queuePausedUntil = null
        unpaused = true
        this.saveProjects(this.db)
        this.emit('project.updated', { projectId: project.id })
      }

      let tasks
      try { tasks = listTasks(project.path) } catch { continue }
      for (const t of dueTasks(tasks, now)) {
        // Limpa o horário ANTES de enfileirar: se o enqueue falhar (task já na
        // fila, por exemplo), o agendamento não fica disparando a cada tick.
        const task = updateTask(project.path, t.id, { scheduled_at: null })
        this.emit('task.upserted', { projectId: project.id, task })
        // auto:false — o agendamento é um pedido explícito do usuário, então
        // vale o mesmo que apertar "Executar agora" (libera re-execução).
        this.runner.enqueue(project.id, t.id)
      }
    }
    // A fila pode ter itens parados desde antes da pausa vencer.
    if (unpaused) this.runner.tick()
  }
}
