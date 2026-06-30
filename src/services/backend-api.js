import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import axios from 'axios'
import config from '../config.js'

const http = axios.create({
  baseURL: config.crawler.apiBaseUrl,
  timeout: 60000,
})

function unwrap(response) {
  if (response.data?.code !== 0) {
    throw new Error(response.data?.message || 'Backend request failed')
  }
  return response.data.data
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

export const backendApi = {
  async reportStatus(data) {
    return unwrap(await http.post('/tasks/status', data))
  },

  async upsertAlbum(data) {
    return unwrap(await http.post('/albums/upsert', data))
  },

  async upsertChapter(data) {
    return unwrap(await http.post('/chapters/upsert', data))
  },

  async uploadPage(data) {
    const form = new FormData()
    form.append('albumId', data.albumId)
    form.append('chapterId', data.chapterId)
    form.append('sourceSite', data.sourceSite || '')
    form.append('sourceAlbumId', data.sourceAlbumId || '')
    form.append('sourceChapterId', data.sourceChapterId || '')
    form.append('pageNo', String(data.pageNo))
    form.append('sourceImageUrl', data.sourceImageUrl || '')
    form.append('sha256', data.sha256)
    form.append('file', new Blob([fs.readFileSync(data.filePath)]), path.basename(data.filePath))
    return unwrap(await http.post('/pages/upload', form))
  },

  async uploadCover(data) {
    const form = new FormData()
    form.append('albumId', data.albumId)
    form.append('file', new Blob([fs.readFileSync(data.filePath)]), path.basename(data.filePath))
    return unwrap(await http.post('/albums/cover/upload', form))
  },

  async deleteAlbum(albumId) {
    return unwrap(await http.delete(`/albums/${albumId}`))
  },

  async deleteChapter(chapterId) {
    return unwrap(await http.delete(`/chapters/${chapterId}`))
  },
}
