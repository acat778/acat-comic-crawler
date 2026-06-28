import { SiteAdapter } from './SiteAdapter.js'

export class JmComicAdapter extends SiteAdapter {
  get siteId() {
    return 'jmcomic'
  }

  async getAlbumInfo(page, url) {
    console.log(`[jmcomic] Fetching album: ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 2000))

    const info = await page.evaluate(() => {
      const title =
        document.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('.panel-heading')?.textContent?.trim() ||
        document.title?.replace(/[-–|].*/, '').trim() ||
        'Unknown'

      const authorEl = document.querySelector('.author, [itemprop="author"], a[href*="author"]')
      const author = authorEl?.textContent?.trim().replace(/\s+/g, ' ') || ''

      const coverUrl =
        document.querySelector('.img-responsive')?.src ||
        document.querySelector('img.cover')?.src ||
        document.querySelector('.album-cover img')?.src ||
        ''

      const tags = Array.from(
        document.querySelectorAll('.tag, .label, a[href*="tag"], a[href*="category"]'),
      ).map((el) => el.textContent.trim()).filter(Boolean)

      const description =
        document.querySelector('.description, .album-desc')?.textContent?.trim() ||
        document.querySelector('[itemprop="description"]')?.content?.trim() ||
        ''

      return { title, author, coverUrl, tags, description }
    })

    return { ...info, defaultAdult: true }
  }

  async getChapters(page) {
    console.log('[jmcomic] Fetching chapters...')

    // Navigate to the album's photo list page (non-JS version might be needed)
    // 18comic.vip chapter pages are usually /photo/{albumId}/
    const chapters = await page.evaluate(() => {
      const EXCLUDE_TITLES = ['開始閱讀', '开始阅读', '分頁閱讀', '分页阅读', '評論', '评论', '留言']

      const links = document.querySelectorAll(
        'a[href*="photo/"], ul.list-group a, .list-group-item a, .chapter-list li a, .episode-list a, a[href*="/photo/"]',
      )

      const results = []
      links.forEach((el) => {
        const title = el.textContent.trim()
        // Skip UI links and very short titles
        if (!title || title.length < 2) return
        if (EXCLUDE_TITLES.some((t) => title.includes(t))) return
        // Skip non-photo URLs
        if (!el.href.includes('/photo/')) return
        results.push({ title, url: el.href })
      })

      return results
    })

    // Deduplicate by URL
    const seen = new Set()
    const unique = chapters.filter((ch) => {
      if (seen.has(ch.url)) return false
      seen.add(ch.url)
      return true
    }).map((ch, i) => ({ ...ch, index: i }))

    console.log(`[jmcomic] Found ${unique.length} chapters (filtered from ${chapters.length})`)
    return unique
  }

  async getPageImages(page) {
    console.log('[jmcomic] Fetching page images...')

    // Wait for images to load
    await page.waitForSelector('img', { timeout: 15000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))

    // Scroll down to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight
          window.scrollBy(0, window.innerHeight * 0.8)
          totalHeight += window.innerHeight * 0.8
          if (totalHeight >= scrollHeight || totalHeight > 10000) {
            clearInterval(timer)
            resolve()
          }
        }, 400)
      })
    })
    await new Promise((r) => setTimeout(r, 2000))

    const images = await page.evaluate(() => {
      const urls = []
      const imgElements = document.querySelectorAll('img')

      imgElements.forEach((img, i) => {
        // Try various image URL sources
        const src =
          img.getAttribute('data-original') ||
          img.getAttribute('data-src') ||
          img.getAttribute('src') ||
          ''

        if (!src) return
        if (src.startsWith('data:')) return

        // Filter out UI images
        const skipPatterns = ['avatar', 'icon', 'logo', 'banner', 'header', 'footer', 'thumb', 'cover', 'qr', 'button', 'loading', 'spinner']
        if (skipPatterns.some((p) => src.toLowerCase().includes(p))) return

        // Only include actual comic images (usually on cdn-msp domain or similar)
        const url = src.startsWith('//') ? `https:${src}` : src
        if (!url.startsWith('http')) return

        urls.push({ pageNo: urls.length + 1, imageUrl: url })
      })

      // Try to find image URLs in script tags
      if (urls.length === 0) {
        const scripts = document.querySelectorAll('script')
        for (const script of scripts) {
          const text = script.textContent || ''
          // Look for image arrays
          const patterns = [
            /(?:var|let|const)\s+\w*(?:images?|photos?|pics?)\w*\s*=\s*(\[[^\]]*?\])/gi,
            /(?:chapterImages?|pageImages?)\s*=\s*(\[[^\]]*?\])/gi,
            /"images"\s*:\s*(\[[^\]]*?\])/gi,
          ]
          for (const pattern of patterns) {
            let match
            while ((match = pattern.exec(text)) !== null) {
              try {
                const arr = JSON.parse(match[1])
                if (Array.isArray(arr)) {
                  arr.forEach((item) => {
                    const u = typeof item === 'string' ? item : item?.url || item?.src || ''
                    if (u && (u.startsWith('http') || u.startsWith('//'))) {
                      urls.push({ pageNo: urls.length + 1, imageUrl: u.startsWith('//') ? `https:${u}` : u })
                    }
                  })
                }
              } catch {}
            }
          }
        }
      }

      return urls
    })

    console.log(`[jmcomic] Found ${images.length} page images`)
    return images
  }
}
