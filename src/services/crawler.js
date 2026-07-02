import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import config from '../config.js'
import { getBrowser, newPage } from './browser.js'
import { initClient } from './jmcomic-api.js'
import { backendApi, sha256File } from './backend-api.js'
import { getAdapter } from '../sites/registry.js'
import { storage } from '../store/storage.js'
import { descramble } from './descramble.js'

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

function getTaskDownloadDir(task) {
  if (!task?.albumTitle) return null
  const safeName = task.albumTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 60)
  return path.resolve(config.crawler.downloadDir, safeName)
}

function hasRemoteUpload(task) {
  if (!task) return false
  if (task.backendCoverFileId || task.backendAlbumId) return true
  return (task.chapters || []).some((chapter) => (
    chapter.backendChapterId || (chapter.pages || []).some((page) => page.backendPageImageId || page.backendPageId)
  ))
}

function isImageBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70 &&
    buffer[8] === 0x61 && buffer[9] === 0x76 && buffer[10] === 0x69 && buffer[11] === 0x66) {
    return true
  }
  return buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
}

function calculateProgress(chapters) {
  return {
    total: chapters.length,
    done: chapters.filter((chapter) => chapter.status === 'completed').length,
    failed: chapters.filter((chapter) => chapter.status === 'failed' || chapter.status === 'partial').length,
  }
}

function normalizeChapterIndexes(task, requestedIndexes) {
  const chapters = task.chapters || []
  if (!requestedIndexes || requestedIndexes.length === 0) {
    return chapters.map((_chapter, index) => index)
  }

  const uniqueIndexes = [...new Set(requestedIndexes.map((value) => Number(value)))]
  for (const index of uniqueIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= chapters.length) {
      throw new Error(`Invalid chapter index: ${index}`)
    }
  }
  return uniqueIndexes
}

function toIndexSet(indexes) {
  return indexes && indexes.length > 0 ? new Set(indexes) : null
}

function mergeChaptersForRun(currentChapters, nextChapters, retryIndexes) {
  return nextChapters.map((chapter, index) => {
    const existing = currentChapters[index]
    if (retryIndexes && !retryIndexes.has(index)) {
      return existing
        ? { ...existing, title: chapter.title, url: chapter.url, index: chapter.index }
        : { ...chapter, status: 'pending', pages: [] }
    }
    return {
      ...chapter,
      status: 'pending',
      pages: [],
      backendChapterId: null,
      error: null,
    }
  })
}

function removeTaskLocalFiles(task) {
  const downloadDir = getTaskDownloadDir(task)
  if (!downloadDir || !fs.existsSync(downloadDir)) return null
  fs.rmSync(downloadDir, { recursive: true, force: true })
  return downloadDir
}

function removeChapterLocalFiles(task, chapterIndexes) {
  const downloadDir = getTaskDownloadDir(task)
  if (!downloadDir || !fs.existsSync(downloadDir)) return []
  const removed = []
  for (const index of chapterIndexes) {
    const chapterDir = path.join(downloadDir, `${index + 1}`.padStart(3, '0'))
    if (fs.existsSync(chapterDir)) {
      fs.rmSync(chapterDir, { recursive: true, force: true })
      removed.push(chapterDir)
    }
  }
  return removed
}

function addLog(taskId, level, message) {
  const task = storage.getTask(taskId)
  if (!task) return
  const logs = [...(task.logs || []), { level, message, time: new Date().toISOString() }]
  storage.updateTask(taskId, { logs })
  console.log(`[Task ${taskId.substring(0, 8)}] [${level}] ${message}`)
}

async function reportBackendStatus(taskId, status, lastError) {
  const task = storage.getTask(taskId)
  if (!task) return
  try {
    await backendApi.reportStatus({
      taskId,
      albumId: task.backendAlbumId || null,
      sourceSite: task.site,
      sourceAlbumId: task.sourceAlbumId || null,
      status,
      lastError: lastError || null,
    })
  } catch (err) {
    addLog(taskId, 'warn', `Backend status report failed: ${err.message}`)
  }
}

async function upsertBackendAlbum(taskId, albumInfo) {
  const task = storage.getTask(taskId)
  const result = await backendApi.upsertAlbum({
    sourceSite: task.site,
    sourceAlbumId: task.sourceAlbumId || null,
    realSourceAlbumId: task.sourceAlbumId || null,
    title: albumInfo.title,
    authorName: albumInfo.author || '',
    description: albumInfo.description || '',
    defaultAdult: config.jmcomic.defaultAdult,
  })
  storage.updateTask(taskId, { backendAlbumId: result.albumId })
  addLog(taskId, 'info', `Backend album ${result.created ? 'created' : 'reused'}: ${result.albumId}`)
  return result.albumId
}

async function upsertBackendChapter(taskId, chapter, sortOrder, sourceChapterId) {
  const task = storage.getTask(taskId)
  const result = await backendApi.upsertChapter({
    albumId: task.backendAlbumId,
    sourceSite: task.site,
    sourceAlbumId: task.sourceAlbumId || null,
    sourceChapterId: sourceChapterId || null,
    title: chapter.title,
    sortOrder,
  })
  addLog(taskId, 'info', `Backend chapter ${result.created ? 'created' : 'reused'}: ${result.chapterId}`)
  return result.chapterId
}

async function uploadBackendPage(taskId, chapterId, pageItem, sourceChapterId) {
  const task = storage.getTask(taskId)
  const sha256 = sha256File(pageItem.localPath)
  const result = await backendApi.uploadPage({
    albumId: task.backendAlbumId,
    chapterId,
    sourceSite: task.site,
    sourceAlbumId: task.sourceAlbumId || null,
    sourceChapterId: sourceChapterId || null,
    pageNo: pageItem.pageNo,
    sourceImageUrl: pageItem.imageUrl,
    sha256,
    filePath: pageItem.localPath,
  })
  pageItem.backendPageImageId = result.pageImageId || result.pageId
  pageItem.sha256 = sha256
  return pageItem.backendPageImageId
}

async function uploadBackendCover(taskId, coverImageUrl) {
  const task = storage.getTask(taskId)
  if (!coverImageUrl) {
    addLog(taskId, 'info', 'No cover image URL, skipping cover upload')
    return null
  }
  if (task.backendCoverFileId) {
    addLog(taskId, 'info', `Cover already uploaded: ${task.backendCoverFileId}`)
    return task.backendCoverFileId
  }
  try {
    const downloadDir = ensureDownloadDir(task.albumTitle)
    const coverExt = coverImageUrl.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)?.[1] || 'jpg'
    const coverPath = path.join(downloadDir, '_cover.' + coverExt)
    const resp = await axios.get(coverImageUrl, {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    const coverBuffer = Buffer.from(resp.data)
    if (!isImageBuffer(coverBuffer)) {
      throw new Error(`Downloaded cover is not a valid image (${coverBuffer.length} bytes)`)
    }
    fs.writeFileSync(coverPath, coverBuffer)
    const result = await backendApi.uploadCover({
      albumId: task.backendAlbumId,
      filePath: coverPath,
    })
    storage.updateTask(taskId, { backendCoverFileId: result.fileId })
    addLog(taskId, 'info', `Cover uploaded: ${result.fileId}`)
    return result.fileId
  } catch (err) {
    addLog(taskId, 'warn', `Cover upload skipped: ${err.message}`)
    return null
  }
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
    // JMComic mobile API — bypasses Cloudflare, returns structured data
    console.log(`[Search] JMComic API for "${keyword}"...`)
    try {
      const client = await initClient()
      const apiResult = await client.search(keyword, { page: 1 })

      const total = parseInt(apiResult.total || '0', 10)
      const items = apiResult.content || []
      const results = items.map((item) => ({
        title: item.name || '',
        url: `https://${new URL(client.baseURL).hostname}/album/${item.id}`,
        snippet: `作者: ${item.author || ''}`,
      }))

      console.log(`[Search] API returned ${results.length} results (total: ${total})`)
      return { results, hasMore: results.length >= 30 }
    } catch (err) {
      console.error(`[Search] JMComic API failed: ${err.message}`)
      return { results: [], hasMore: false }
    }
  },

  /** Extract album ID from JMComic URL: /album/123456 or photo/123456 */
  extractAlbumId(url) {
    const m = url.match(/\/album\/(\d+)/) || url.match(/\/photo\/(\d+)/)
    return m ? m[1] : null
  },

  async createTask(url, site = 'jmcomic') {
      const task = {
      id: uuidv4(),
      url,
      site,
      status: 'created',
      albumTitle: '',
      albumInfo: null,
      sourceAlbumId: this.extractAlbumId(url),
      backendAlbumId: null,
      backendCoverFileId: null,
      chapters: [],
      progress: { total: 0, done: 0, failed: 0 },
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    storage.createTask(task)
    addLog(task.id, 'info', `Task created: ${url}`)

    // Try API-based crawl for jmcomic; fall back to Puppeteer for others
    const albumId = task.sourceAlbumId
    if (site === 'jmcomic' && albumId) {
      this.runApiTask(task.id, albumId).catch((err) => {
        console.error(`[Task ${task.id}] API crawl fatal:`, err.message)
        addLog(task.id, 'error', `Fatal: ${err.message}`)
        storage.updateTask(task.id, { status: 'failed', lastError: err.message })
      })
    } else {
      this.runTask(task.id).catch((err) => {
        console.error(`[Task ${task.id}] Fatal:`, err.message)
        addLog(task.id, 'error', `Fatal: ${err.message}`)
        storage.updateTask(task.id, { status: 'failed', lastError: err.message })
      })
    }

    return task
  },

  async runApiTask(taskId, albumId, options = {}) {
    if (activeTasks.has(taskId)) return
    const controller = new AbortController()
    activeTasks.set(taskId, controller)
    const retryIndexes = toIndexSet(options.chapterIndexes)

    try {
      storage.updateTask(taskId, { status: 'running' })
      await reportBackendStatus(taskId, 'running')
      addLog(taskId, 'info', 'Starting API-based crawl...')

      // Initialize API client
      addLog(taskId, 'info', 'Connecting to JMComic API...')
      const client = await initClient()
      addLog(taskId, 'info', `API connected: ${client.baseURL}`)

      // 1. Get album info (includes chapter list in `series`)
      addLog(taskId, 'info', `Fetching album ${albumId}...`)
      const album = await client.getAlbum(albumId)
      const albumTitle = album.name || 'Unknown'
      const chapters = (album.series || []).map((ch, i) => ({
        title: ch.name || `第${ch.sort}話`,
        url: `${client.baseURL}/album/${albumId}?chapter=${ch.id}`,
        index: i,
      }))

      const currentTask = storage.getTask(taskId)
      const runChapters = mergeChaptersForRun(currentTask.chapters || [], chapters, retryIndexes)
      storage.updateTask(taskId, {
        albumTitle,
        albumInfo: { title: albumTitle, author: (album.author || []).join(', '), tags: album.tags || [] },
        chapters: runChapters,
        progress: calculateProgress(runChapters),
      })
      addLog(taskId, 'info', `Album: ${albumTitle} (${chapters.length} chapters)`)
      await upsertBackendAlbum(taskId, {
        title: albumTitle,
        author: (album.author || []).join(', '),
        description: album.description || '',
      })

      // Upload cover image if available
      const coverUrl = client.imageBaseURL
        ? `${client.imageBaseURL}/media/albums/${albumId}/cover.jpg`
        : null
      await uploadBackendCover(taskId, coverUrl)

      if (chapters.length === 0) {
        addLog(taskId, 'warn', 'No chapters found')
        storage.updateTask(taskId, { status: 'failed', lastError: 'No chapters found' })
        return
      }

      // 2. Process each chapter
      const downloadDir = ensureDownloadDir(albumTitle)
      for (let ci = 0; ci < chapters.length; ci++) {
        if (controller.signal.aborted) break
        if (retryIndexes && !retryIndexes.has(ci)) continue

        const chapter = chapters[ci]
        const chapterId = album.series[ci].id
        addLog(taskId, 'info', `Chapter ${ci + 1}/${chapters.length}: ${chapter.title}`)

        try {
          const backendChapterId = await upsertBackendChapter(taskId, chapter, ci + 1, chapterId)
          const backendChapters = storage.getTask(taskId).chapters
          backendChapters[ci] = {
            ...backendChapters[ci],
            backendChapterId,
            sourceChapterId: chapterId,
          }
          storage.updateTask(taskId, { chapters: backendChapters })
          // Get chapter images from API
          const chapterData = await client.getChapter(chapterId)
          const imageNames = chapterData.images || []

          if (imageNames.length === 0) {
            addLog(taskId, 'warn', `  No images for chapter ${chapterId}`)
            const emptyChapters = storage.getTask(taskId).chapters
            emptyChapters[ci] = { ...emptyChapters[ci], status: 'failed', error: 'No images found' }
            storage.updateTask(taskId, {
              chapters: emptyChapters,
              progress: calculateProgress(emptyChapters),
            })
            continue
          }

          // Update chapter with pages
          const updatedChapters = storage.getTask(taskId).chapters
          const pageItems = imageNames.map((name, pi) => ({
            pageNo: pi + 1,
            imageUrl: `${client.imageBaseURL}/media/photos/${chapterId}/${name}`,
            status: 'pending',
          }))
          updatedChapters[ci] = { ...updatedChapters[ci], status: 'processing', pages: pageItems }
          storage.updateTask(taskId, { chapters: updatedChapters })

          // Download each image
          const chapterDir = path.join(downloadDir, `${ci + 1}`.padStart(3, '0'))
          if (!fs.existsSync(chapterDir)) fs.mkdirSync(chapterDir, { recursive: true })

          let chapterFailed = 0
          for (const pageItem of pageItems) {
            if (controller.signal.aborted) break
            try {
              const ext = pageItem.imageUrl.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)?.[1] || 'jpg'
              const savePath = path.join(chapterDir, `${String(pageItem.pageNo).padStart(3, '0')}.${ext}`)

              // Download via axios (CDN might not be behind Cloudflare)
              const resp = await axios.get(pageItem.imageUrl, {
                timeout: 30000,
                responseType: 'arraybuffer',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Referer': client.baseURL,
                },
              })
              let imageBuffer = Buffer.from(resp.data)

              // Descramble JMComic scrambled images (based on album_id + filename hash)
              const imageName = pageItem.imageUrl.split('/').pop()?.split('?')[0] || 'unknown.jpg'
              try {
                imageBuffer = await descramble(imageBuffer, albumId, imageName)
              } catch (err) {
                addLog(taskId, 'warn', `  Descramble failed for ${imageName}: ${err.message}, using original`)
              }

              fs.writeFileSync(savePath, imageBuffer)
              const size = fs.statSync(savePath).size

              pageItem.status = 'downloaded'
              pageItem.localPath = savePath
              await uploadBackendPage(taskId, backendChapterId, pageItem, chapterId)
              addLog(taskId, 'info', `  Page ${pageItem.pageNo}: ${(size / 1024).toFixed(1)}KB ✓`)
              await sleep(500)
            } catch (err) {
              pageItem.status = 'failed'
              pageItem.error = err.message
              chapterFailed++
              addLog(taskId, 'error', `  Page ${pageItem.pageNo}: ${err.message}`)
            }
          }

          // Update chapter status
          const finalChapters = storage.getTask(taskId).chapters
          finalChapters[ci] = {
            ...finalChapters[ci],
            status: chapterFailed === 0 ? 'completed' : 'partial',
            pages: pageItems,
          }
          storage.updateTask(taskId, {
            chapters: finalChapters,
            progress: calculateProgress(finalChapters),
          })
          addLog(taskId, 'info', `Chapter ${ci + 1} done: ${imageNames.length - chapterFailed}/${imageNames.length} images`)
        } catch (err) {
          addLog(taskId, 'error', `Chapter ${ci + 1} FAILED: ${err.message}`)
          const errChapters = storage.getTask(taskId).chapters
          errChapters[ci] = { ...errChapters[ci], status: 'failed', error: err.message }
          storage.updateTask(taskId, {
            chapters: errChapters,
            progress: calculateProgress(errChapters),
          })
        }
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
      await reportBackendStatus(taskId, status)
      addLog(taskId, 'info', `Done: ${status}`)
    } catch (err) {
      addLog(taskId, 'error', err.message)
      storage.updateTask(taskId, { status: 'failed', lastError: err.message })
      await reportBackendStatus(taskId, 'failed', err.message)
    } finally {
      activeTasks.delete(taskId)
    }
  },

  async runTask(taskId, options = {}) {
    if (activeTasks.has(taskId)) return
    const controller = new AbortController()
    activeTasks.set(taskId, controller)
    const retryIndexes = toIndexSet(options.chapterIndexes)

    try {
      storage.updateTask(taskId, { status: 'running' })
      await reportBackendStatus(taskId, 'running')
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
        await upsertBackendAlbum(taskId, albumInfo)

        // Upload cover if the adapter extracted a cover URL
        if (albumInfo.coverUrl) {
          await uploadBackendCover(taskId, albumInfo.coverUrl)
        }

        // 2. Get chapters
        addLog(taskId, 'info', 'Fetching chapters...')
        const chapters = await adapter.getChapters(page)
        if (chapters.length === 0) {
          addLog(taskId, 'warn', 'No chapters found. Try a different album URL.')
          storage.updateTask(taskId, { status: 'failed', lastError: 'No chapters found' })
          return
        }

        const currentTask = storage.getTask(taskId)
        const runChapters = mergeChaptersForRun(currentTask.chapters || [], chapters, retryIndexes)
        storage.updateTask(taskId, {
          chapters: runChapters,
          progress: calculateProgress(runChapters),
        })
        addLog(taskId, 'info', `Found ${chapters.length} chapters`)

        // 3. Process each chapter
        const downloadDir = ensureDownloadDir(albumInfo.title)
        addLog(taskId, 'info', `Download dir: ${downloadDir}`)
        for (let ci = 0; ci < chapters.length; ci++) {
          if (controller.signal.aborted) break
          if (retryIndexes && !retryIndexes.has(ci)) continue

          const chapter = chapters[ci]
          addLog(taskId, 'info', `Chapter ${ci + 1}/${chapters.length}: ${chapter.title.substring(0, 60)}`)

          try {
            const backendChapterId = await upsertBackendChapter(taskId, chapter, ci + 1, chapter.url)
            const backendChapters = storage.getTask(taskId).chapters
            backendChapters[ci] = {
              ...backendChapters[ci],
              backendChapterId,
              sourceChapterId: chapter.url,
            }
            storage.updateTask(taskId, { chapters: backendChapters })
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

                // Descramble JMComic scrambled images (browser download path)
                const task = storage.getTask(taskId)
                let finalSize = size
                if (task && task.sourceAlbumId) {
                  try {
                    const imgBuf = fs.readFileSync(savePath)
                    const imgName = pi.imageUrl.split('/').pop()?.split('?')[0] || 'unknown.jpg'
                    const descrambledBuf = await descramble(imgBuf, task.sourceAlbumId, imgName)
                    fs.writeFileSync(savePath, descrambledBuf)
                    finalSize = descrambledBuf.length
                  } catch (err) {
                    addLog(taskId, 'warn', `  Descramble failed for ${pi.pageNo}: ${err.message}, using original`)
                  }
                }

                pi.status = 'downloaded'
                pi.localPath = savePath
                pi.fileSize = finalSize
                await uploadBackendPage(taskId, backendChapterId, pi, chapter.url)
                addLog(taskId, 'info', `  Page ${pi.pageNo}: ${(finalSize / 1024).toFixed(1)}KB ✓`)
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

            storage.updateTask(taskId, {
              chapters: finalChapters,
              progress: calculateProgress(finalChapters),
            })
            addLog(taskId, 'info', `Chapter ${ci + 1} done: ${pageImages.length - chapterFailed}/${pageImages.length} images`)
          } catch (err) {
            addLog(taskId, 'error', `Chapter ${ci + 1} FAILED: ${err.message}`)
            const errChapters = storage.getTask(taskId).chapters
            errChapters[ci] = { ...errChapters[ci], status: 'failed', error: err.message }
            storage.updateTask(taskId, {
              chapters: errChapters,
              progress: calculateProgress(errChapters),
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
      await reportBackendStatus(taskId, status)
      addLog(taskId, 'info', `Done: ${status}`)
    } catch (err) {
      addLog(taskId, 'error', err.message)
      storage.updateTask(taskId, { status: 'failed', lastError: err.message })
      await reportBackendStatus(taskId, 'failed', err.message)
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

  async deleteTask(taskId, options = {}) {
    const task = storage.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const deleteRemote = options.deleteRemote !== false
    const hadRemoteUpload = hasRemoteUpload(task)

    addLog(taskId, 'info', 'Deleting task...')

    // 1. Cancel if running
    if (activeTasks.has(taskId)) {
      await this.cancelTask(taskId)
    }

    // 2. Delete backend data and RustFS objects only when explicitly requested.
    if (hadRemoteUpload && deleteRemote) {
      addLog(taskId, 'info', 'Cleaning up backend data...')
      if (task.backendAlbumId) {
        try {
          await backendApi.deleteAlbum(task.backendAlbumId)
          addLog(taskId, 'info', 'Deleted backend album and RustFS files')
        } catch (err) {
          addLog(taskId, 'warn', `Failed to delete album: ${err.message}`)
        }
      } else {
        for (const chapter of (task.chapters || [])) {
          if (chapter.backendChapterId) {
            try {
              await backendApi.deleteChapter(chapter.backendChapterId)
              addLog(taskId, 'info', `Deleted backend chapter: ${chapter.title}`)
            } catch (err) {
              addLog(taskId, 'warn', `Failed to delete chapter ${chapter.title}: ${err.message}`)
            }
          }
        }
      }
    } else if (hadRemoteUpload) {
      addLog(taskId, 'info', 'Backend/RustFS data preserved by delete option')
    }

    // 3. Delete local downloaded files
    const deletedLocalDir = removeTaskLocalFiles(task)
    if (deletedLocalDir) {
      addLog(taskId, 'info', `Deleted local files: ${deletedLocalDir}`)
    }

    // 4. Delete from tasks.json
    storage.deleteTask(taskId)
    console.log(`[Task ${taskId.substring(0, 8)}] Task deleted`)
    return { success: true, hadRemoteUpload, remoteDeleted: hadRemoteUpload && deleteRemote, localDeleted: Boolean(deletedLocalDir) }
  },

  async retryTask(taskId, options = {}) {
    const task = storage.getTask(taskId)
    if (!task) throw new Error('Task not found')

    if (activeTasks.has(taskId) || task.status === 'running' || task.status === 'retrying') {
      throw new Error(`Task cannot be retried while running. Current status: ${task.status}`)
    }

    const chapterIndexes = normalizeChapterIndexes(task, options.chapterIndexes)
    const retryAll = chapterIndexes.length === (task.chapters || []).length
    const missingBackendChapter = chapterIndexes.some((index) => !task.chapters[index]?.backendChapterId)
    if (missingBackendChapter && task.backendAlbumId && !retryAll) {
      throw new Error('部分章节缺少后端章节ID，无法安全清理指定章节；请执行整本重试')
    }
    addLog(taskId, 'info', retryAll ? 'Retrying all chapters...' : `Retrying chapters: ${chapterIndexes.map((i) => i + 1).join(', ')}`)

    // 1. Delete selected chapters from backend. The backend cascades MySQL page records,
    // file records and RustFS objects for the chapter.
    const deleteAlbumBeforeRetry = missingBackendChapter && retryAll && task.backendAlbumId
    if (deleteAlbumBeforeRetry) {
      addLog(taskId, 'info', 'Chapter IDs are missing; deleting backend album before full retry...')
      await backendApi.deleteAlbum(task.backendAlbumId)
      storage.updateTask(taskId, { backendAlbumId: null, backendCoverFileId: null })
      addLog(taskId, 'info', 'Deleted backend album before full retry')
    } else {
      addLog(taskId, 'info', 'Cleaning up backend chapters before retry...')
      for (const index of chapterIndexes) {
        const chapter = task.chapters[index]
        if (chapter?.backendChapterId) {
          try {
            await backendApi.deleteChapter(chapter.backendChapterId)
            addLog(taskId, 'info', `Deleted backend chapter before retry: ${chapter.title}`)
          } catch (err) {
            addLog(taskId, 'warn', `Failed to delete chapter before retry: ${chapter.title || index + 1}: ${err.message}`)
          }
        }
      }
    }

    // 2. Remove selected local chapter files before re-downloading.
    const removedDirs = removeChapterLocalFiles(task, chapterIndexes)
    for (const removedDir of removedDirs) {
      addLog(taskId, 'info', `Deleted local chapter files: ${removedDir}`)
    }

    // 3. Reset selected chapters only.
    const retryIndexSet = new Set(chapterIndexes)
    const resetChapters = (task.chapters || []).map((chapter, index) => {
      if (!retryIndexSet.has(index)) return chapter
      return {
        ...chapter,
        status: 'pending',
        pages: [],
        error: null,
        backendChapterId: null,
      }
    })

    storage.updateTask(taskId, {
      status: 'retrying',
      lastError: null,
      chapters: resetChapters,
      progress: calculateProgress(resetChapters),
      ...(deleteAlbumBeforeRetry ? { backendAlbumId: null, backendCoverFileId: null } : {}),
    })

    // 4. Re-run selected chapters. upsertAlbum is idempotent; selected chapters are re-created.
    addLog(taskId, 'info', 'Restarting crawl...')
    const albumId = task.sourceAlbumId
    if (task.site === 'jmcomic' && albumId) {
      this.runApiTask(taskId, albumId, { chapterIndexes }).catch((err) => {
        console.error(`[Task ${taskId}] Retry API crawl fatal:`, err.message)
        addLog(taskId, 'error', `Retry fatal: ${err.message}`)
        storage.updateTask(taskId, { status: 'failed', lastError: err.message })
      })
    } else {
      this.runTask(taskId, { chapterIndexes }).catch((err) => {
        console.error(`[Task ${taskId}] Retry fatal:`, err.message)
        addLog(taskId, 'error', `Retry fatal: ${err.message}`)
        storage.updateTask(taskId, { status: 'failed', lastError: err.message })
      })
    }

    return storage.getTask(taskId)
  },

  getTask(taskId) {
    const task = storage.getTask(taskId)
    return task ? { ...task, hasRemoteUpload: hasRemoteUpload(task) } : null
  },

  listTasks() {
    return storage.listTasks().map((task) => ({ ...task, hasRemoteUpload: hasRemoteUpload(task) }))
  },
}
