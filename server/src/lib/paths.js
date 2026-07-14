import path from 'node:path'
import os from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

export const APP_VERSION = '0.1.0'
export const HOME_DIR = process.env.CLAUDE_KANBAN_HOME || path.join(os.homedir(), '.claude-kanban')
export const PROJECTS_FILE = path.join(HOME_DIR, 'projects.json')
export const STATE_FILE = path.join(HOME_DIR, 'state.json')
export const LOCK_FILE = path.join(HOME_DIR, 'lock')

export const STATUSES = ['backlog', 'todo', 'doing', 'done', 'archived']

export function kanbanDir(projectPath) {
  return path.join(projectPath, '.claude', 'claude-kanban')
}
export function tasksDir(projectPath, status = '') {
  return path.join(kanbanDir(projectPath), 'tasks', status)
}
export function templatesDir(projectPath) {
  return path.join(kanbanDir(projectPath), 'templates')
}
export function diffFile(projectPath, taskId) {
  return path.join(kanbanDir(projectPath), 'diffs', `${taskId}.diff`)
}
export function logFile(projectPath, taskId) {
  return path.join(kanbanDir(projectPath), 'logs', `${taskId}.jsonl`)
}
export function pendingFile(projectPath) {
  return path.join(kanbanDir(projectPath), 'pending-actions.md')
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

export function loadProjects() {
  return readJson(PROJECTS_FILE, { projects: [] })
}
export function saveProjects(data) {
  writeJson(PROJECTS_FILE, data)
}
export function loadState() {
  return readJson(STATE_FILE, { queue: [] })
}
export function saveState(state) {
  writeJson(STATE_FILE, state)
}
