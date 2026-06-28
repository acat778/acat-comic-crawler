import fs from 'fs'
import path from 'path'
import config from '../config.js'

const DATA_FILE = path.join(config.crawler.dataDir, 'tasks.json')

function ensureDir() {
  const dir = path.dirname(DATA_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readAll() {
  ensureDir()
  try {
    if (!fs.existsSync(DATA_FILE)) return []
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function writeAll(tasks) {
  ensureDir()
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf-8')
}

export const storage = {
  createTask(task) {
    const tasks = readAll()
    tasks.push(task)
    writeAll(tasks)
    return task
  },

  getTask(id) {
    return readAll().find((t) => t.id === id) || null
  },

  updateTask(id, updates) {
    const tasks = readAll()
    const idx = tasks.findIndex((t) => t.id === id)
    if (idx === -1) return null
    tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() }
    writeAll(tasks)
    return tasks[idx]
  },

  listTasks() {
    return readAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  },

  deleteTask(id) {
    const tasks = readAll().filter((t) => t.id !== id)
    writeAll(tasks)
  },
}
