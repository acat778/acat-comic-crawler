import { Router } from 'express'
import { crawlerService } from '../services/crawler.js'
import { listAdapters } from '../sites/registry.js'

const router = Router()

// GET /api/crawler/health
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', adapters: listAdapters() })
})

// GET /api/crawler/search?keyword=&site=
router.get('/search', async (req, res) => {
  try {
    const { keyword, site = 'jmcomic' } = req.query
    if (!keyword || keyword.trim() === '') {
      return res.status(400).json({ error: 'keyword is required' })
    }
    const timeout = setTimeout(() => {
      res.status(408).json({ error: 'Search timed out (90s)' })
    }, 90000)
    try {
      const result = await crawlerService.search(keyword.trim(), site)
      clearTimeout(timeout)
      res.json(result)
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  } catch (err) {
    console.error('[Search] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/crawler/tasks
router.post('/tasks', async (req, res) => {
  try {
    const { url, site = 'jmcomic' } = req.body
    if (!url || url.trim() === '') {
      return res.status(400).json({ error: 'url is required' })
    }
    const task = await crawlerService.createTask(url.trim(), site)
    res.json(task)
  } catch (err) {
    console.error('[Tasks] Create error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/crawler/tasks
router.get('/tasks', (_req, res) => {
  res.json(crawlerService.listTasks())
})

// GET /api/crawler/tasks/:id
router.get('/tasks/:id', (req, res) => {
  const task = crawlerService.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  res.json(task)
})

// POST /api/crawler/tasks/:id/cancel
router.post('/tasks/:id/cancel', async (req, res) => {
  try {
    const task = await crawlerService.cancelTask(req.params.id)
    res.json(task)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/crawler/tasks/:id/logs
router.get('/tasks/:id/logs', (req, res) => {
  const task = crawlerService.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  res.json(task.logs || [])
})

export default router
