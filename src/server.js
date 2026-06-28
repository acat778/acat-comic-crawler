import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import config from './config.js'
import crawlerRoutes from './routes/crawler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(cors())
app.use(express.json())

// API routes
app.use('/api/crawler', crawlerRoutes)

// Static files
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist')
app.use(express.static(frontendDist))

// SPA fallback — use middleware for unmatched non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  const indexPath = path.join(frontendDist, 'index.html')
  res.sendFile(indexPath, (err) => {
    if (err) next()
  })
})

// Start
const port = config.server.port
app.listen(port, () => {
  console.log(`\nComic Crawler Server http://localhost:${port}`)
  console.log(`API: http://localhost:${port}/api/crawler`)
  console.log(`Downloads: ${path.resolve(config.crawler.downloadDir)}\n`)
})
