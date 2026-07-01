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

// DELETE /api/crawler/tasks/:id
// 删除任务，同时清理本地下载文件；deleteRemote=false 时保留后端/RustFS 数据
router.delete('/tasks/:id', async (req, res) => {
  try {
    const deleteRemote = req.query.deleteRemote !== 'false'
    const result = await crawlerService.deleteTask(req.params.id, { deleteRemote })
    res.json(result)
  } catch (err) {
    console.error('[Tasks] Delete error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/crawler/tasks/:id/retry
// 重试任务；body.chapterIndexes 为空时重试整本，传入索引数组时仅重试指定章节
router.post('/tasks/:id/retry', async (req, res) => {
  try {
    const task = await crawlerService.retryTask(req.params.id, {
      chapterIndexes: Array.isArray(req.body?.chapterIndexes) ? req.body.chapterIndexes : undefined,
    })
    res.json(task)
  } catch (err) {
    console.error('[Tasks] Retry error:', err.message)
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
