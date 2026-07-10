import chokidar from 'chokidar'
import path from 'node:path'
import { kanbanDir, pendingFile } from './paths.js'
import { loadTask, isSelfWrite, statusFromPath, findTask } from './tasks.js'
import { listPendingActions } from './pending.js'

// Um watcher por projeto. Detecta unlink+add do mesmo id como move.
export function watchProject(project, emit) {
  const tasksGlob = path.join(kanbanDir(project.path), 'tasks')
  const pending = pendingFile(project.path)
  const recentUnlinks = new Map() // taskId inferido por nome de arquivo -> {status, timer}

  const watcher = chokidar.watch([tasksGlob, pending], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  const idFromFile = f => path.basename(f, '.md').match(/--(\w+)$/)?.[1] || path.basename(f)

  watcher.on('all', (event, filePath) => {
    if (filePath === pending) {
      if (event === 'change' || event === 'add') {
        emit('pending.updated', { projectId: project.id, actions: listPendingActions(project.path) })
      }
      return
    }
    if (!filePath.endsWith('.md')) return
    if (isSelfWrite(filePath)) return

    if (event === 'add' || event === 'change') {
      let task
      try { task = loadTask(project.path, filePath) } catch { return }
      const key = idFromFile(filePath)
      const prev = recentUnlinks.get(key) || recentUnlinks.get(task.id)
      if (event === 'add' && prev) {
        clearTimeout(prev.timer)
        recentUnlinks.delete(key); recentUnlinks.delete(task.id)
        emit('task.moved', { projectId: project.id, taskId: task.id, from: prev.status, to: task.status })
      }
      emit('task.upserted', { projectId: project.id, task })
    } else if (event === 'unlink') {
      const key = idFromFile(filePath)
      const status = statusFromPath(filePath)
      const timer = setTimeout(() => {
        recentUnlinks.delete(key)
        // O `add` correspondente a uma troca de status pode ter chegado antes do
        // `unlink` (rename fora de ordem). Só remove se a task realmente sumiu do disco.
        const still = findTask(project.path, key)
        if (still) { emit('task.upserted', { projectId: project.id, task: still }); return }
        emit('task.removed', { projectId: project.id, taskId: key })
      }, 1000)
      recentUnlinks.set(key, { status, timer })
    }
  })

  return watcher
}
