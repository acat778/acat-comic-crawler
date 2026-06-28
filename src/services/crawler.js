import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import config from '../config.js'
import { newPage, googleSearch } from './browser.js'
import { getAdapter } from '../sites/registry.js'
import { storage } from '../store/storage.js'

const activeTasks = new Map()

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function ensureDownloadDir(albumTitle) {
  const safeName = albumTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 60)
  const dir = path.resolve(config.crawler.downloadDir, safeName)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function addLog(taskId, level, message) {
  const task = storage.getTask(taskId)
  if (!task) return
  const logs = [...(task.logs || []), { level, message, time: new Date().toISOString() }]
  storage.updateTask(taskId, { logs })
  console.log(`[Task ${taskId.substring(0, 8)}] [${level}] ${message}`)
}

async function downloadImage(page, imageUrl, savePath) {
  try {
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Referer: 'https://18comic.vip/' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      return Array.from(new Uint8Array(buf))
    }, imageUrl)

    const buffer = Buffer.from(response)
    fs.writeFileSync(savePath, buffer)
    return buffer.length
  } catch (err) {
    throw err
  }
}

export const crawlerService = {
  async search(keyword, site = 'jmcomic') {
    const results = await googleSearch(keyword)
    return { results, hasMore: results.length >= 10 }
  },

  async createTask(url, site = 'jmcomic') {
    const task = {
      id: uuidv4(),
      url,
      site,
      status: 'created',
      albumTitle: '',
      albumInfo: null,
      chapters: [],
      progress: { total: 0, done: 0, failed: 0 },
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    storage.createTask(task)
    addLog(task.id, 'info', `Task created: ${url}`)

    // Run async
    this.runTask(task.id).catch((err) => {
      console.error(`[Task ${task.id}] Fatal:`, err.message)
      addLog(task.id, 'error', `Fatal: ${err.message}`)
      storage.updateTask(task.id, { status: 'failed', lastError: err.message })
    })

    return task
  },

  async runTask(taskId) {
    if (activeTasks.has(taskId)) return
    const controller = new AbortController()
    activeTasks.set(taskId, controller)

    try {
      storage.updateTask(taskId, { status: 'running' })
      addLog(taskId, 'info', 'Starting crawl...')

      const task = storage.getTask(taskId)
      const adapter = getAdapter(task.site)
      const page = await newPage()

      try {
        // 1. Get album info
        addLog(taskId, 'info', 'Fetching album info...')
        const albumInfo = await adapter.getAlbumInfo(page, task.url)
        storage.updateTask(taskId, { albumTitle: albumInfo.title, albumInfo })
        addLog(taskId, 'info', `Album: ${albumInfo.title}`)

        // 2. Get chapters
        addLog(taskId, 'info', 'Fetching chapters...')
        const chapters = await adapter.getChapters(page)
        if (chapters.length === 0) {
          addLog(taskId, 'warn', 'No chapters found. Try a different album URL.')
          storage.updateTask(taskId, { status: 'failed', lastError: 'No chapters found' })
          return
        }

        storage.updateTask(taskId, {
          chapters: chapters.map((ch) => ({ ...ch, status: 'pending', pages: [] })),
          progress: { total: chapters.length, done: 0, failed: 0 },
        })
        addLog(taskId, 'info', `Found ${chapters.length} chapters`)

        // 3. Process each chapter
        const downloadDir = ensureDownloadDir(albumInfo.title)
        addLog(taskId, 'info', `Download dir: ${downloadDir}`)
        let doneCount = 0
        let failedCount = 0

        for (let ci = 0; ci < chapters.length; ci++) {
          if (controller.signal.aborted) break

          const chapter = chapters[ci]
          addLog(taskId, 'info', `Chapter ${ci + 1}/${chapters.length}: ${chapter.title.substring(0, 60)}`)

          try {
            await page.goto(chapter.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await sleep(config.crawler.requestDelay)

            const pageImages = await adapter.getPageImages(page)
            addLog(taskId, 'info', `  Found ${pageImages.length} images`)

            // Update chapter with pages
            const updatedChapters = storage.getTask(taskId).chapters
            updatedChapters[ci] = {
              ...updatedChapters[ci],
              status: pageImages.length > 0 ? 'processing' : 'failed',
              pages: pageImages.map((p) => ({ ...p, status: 'pending', localPath: '' })),
            }
            storage.updateTask(taskId, { chapters: updatedChapters })

            // Download each image
            const chapterDir = path.join(downloadDir, `${ci + 1}`.padStart(3, '0'))
            if (!fs.existsSync(chapterDir)) fs.mkdirSync(chapterDir, { recursive: true })

            let chapterFailed = 0
            for (const pi of pageImages) {
              if (controller.signal.aborted) break
              try {
                const ext = pi.imageUrl.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)?.[1] || 'jpg'
                const savePath = path.join(chapterDir, `${String(pi.pageNo).padStart(3, '0')}.${ext}`)
                const size = await downloadImage(page, pi.imageUrl, savePath)
                pi.status = 'downloaded'
                pi.localPath = savePath
                pi.fileSize = size
                addLog(taskId, 'info', `  Page ${pi.pageNo}: ${(size / 1024).toFixed(1)}KB ✓`)
                await sleep(500)
              } catch (err) {
                pi.status = 'failed'
                pi.error = err.message
                chapterFailed++
                addLog(taskId, 'error', `  Page ${pi.pageNo}: ${err.message}`)
              }
            }

            // Update chapter status
            const finalChapters = storage.getTask(taskId).chapters
            finalChapters[ci] = {
              ...finalChapters[ci],
              status: chapterFailed === 0 ? 'completed' : 'partial',
              pages: pageImages,
            }

            if (chapterFailed === 0) doneCount++
            else failedCount++

            storage.updateTask(taskId, {
              chapters: finalChapters,
              progress: { total: chapters.length, done: doneCount, failed: failedCount },
            })
            addLog(taskId, 'info', `Chapter ${ci + 1} done: ${pageImages.length - chapterFailed}/${pageImages.length} images`)
          } catch (err) {
            failedCount++
            addLog(taskId, 'error', `Chapter ${ci + 1} FAILED: ${err.message}`)
            const errChapters = storage.getTask(taskId).chapters
            errChapters[ci] = { ...errChapters[ci], status: 'failed', error: err.message }
            storage.updateTask(taskId, {
              chapters: errChapters,
              progress: { total: chapters.length, done: doneCount, failed: failedCount },
            })
          }
        }
      } finally {
        await page.close()
      }

      const final = storage.getTask(taskId)
      const allDone = final.chapters.every((ch) => ch.status === 'completed')
      const someFailed = final.chapters.some((ch) => ch.status === 'failed' || ch.status === 'partial')
      const status = controller.signal.aborted
        ? 'cancelled'
        : allDone ? 'completed'
        : someFailed ? 'partial_failed'
        : 'failed'

      storage.updateTask(taskId, { status })
      addLog(taskId, 'info', `Done: ${status}`)
    } catch (err) {
      addLog(taskId, 'error', err.message)
      storage.updateTask(taskId, { status: 'failed', lastError: err.message })
    } finally {
      activeTasks.delete(taskId)
    }
  },

  async cancelTask(taskId) {
    const ctrl = activeTasks.get(taskId)
    if (ctrl) ctrl.abort()
    storage.updateTask(taskId, { status: 'cancelled' })
    addLog(taskId, 'info', 'Task cancelled')
    return storage.getTask(taskId)
  },

  getTask(taskId) {
    return storage.getTask(taskId)
  },

  listTasks() {
    return storage.listTasks()
  },
}
