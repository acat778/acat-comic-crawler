import { SiteAdapter } from './SiteAdapter.js'
import { isCloudflareBlocked } from '../services/browser.js'

export class JmComicAdapter extends SiteAdapter {
  get siteId() {
    return 'jmcomic'
  }

  /**
   * Search by navigating to a mirror's homepage, waiting for Cloudflare to clear,
   * then attempting to search via URL or form interaction.
   */
  async searchByPage(page, keyword) {
    console.log(`[jmcomic] searchByPage keyword="${keyword}"`)

    // Try first 2 mirrors max (bounds search time for the 90s route timeout)
    const mirrors = (this.config.mirrors || [this.config.baseUrl]).slice(0, 2)

    for (const mirror of mirrors) {
      console.log(`[jmcomic] Trying mirror: ${mirror}`)
      try {
        // Step 1: Navigate to homepage (Cloudflare challenge fires here)
        console.log(`[jmcomic] Loading homepage: ${mirror}`)
        await page.goto(mirror, { waitUntil: 'domcontentloaded', timeout: 25000 })

        // Step 2: Wait for Cloudflare managed challenge to clear (up to ~30s)
        let cfCleared = false
        for (let w = 0; w < 15; w++) {
          await new Promise((r) => setTimeout(r, 2000))
          if (!(await isCloudflareBlocked(page))) {
            cfCleared = true
            console.log(`[jmcomic] Cloudflare cleared after ${(w + 1) * 2}s`)
            break
          }
          if (w === 0 || w === 5 || w === 10) {
            console.log(`[jmcomic] Still waiting for Cloudflare (${(w + 1) * 2}s)...`)
          }
        }

        if (!cfCleared) {
          console.warn(`[jmcomic] ${mirror} Cloudflare did not clear, trying next mirror`)
          continue
        }

        // Debug: log page state
        const pageInfo = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          textLen: document.body?.innerText?.length || 0,
        }))
        console.log(`[jmcomic] Homepage loaded: "${pageInfo.title}" url=${pageInfo.url?.substring(0,100)}`)

        // Step 3: Submit search form (stays on same origin, avoids re-triggering Cloudflare)
        const searchSubmitted = await page.evaluate((kw) => {
          const searchInput = document.querySelector('#search_form input[name="search_query"], #search_form_m input[name="search_query"], input[name="search_query"]')
          if (!searchInput) return 'no_input'

          const form = searchInput.closest('form')
          if (!form) return 'no_form'

          // Fill search input
          searchInput.value = kw
          searchInput.dispatchEvent(new Event('input', { bubbles: true }))

          // Submit the form
          form.submit()
          return 'submitted'
        }, keyword)

        console.log(`[jmcomic] Search form: ${searchSubmitted}`)
        if (searchSubmitted !== 'submitted') {
          console.warn(`[jmcomic] Could not submit search form on ${mirror}`)
          continue
        }

        // Step 4: Wait for navigation to search results
        await new Promise((r) => setTimeout(r, 3000))

        // Re-check for Cloudflare on the search results page (new URL = new challenge)
        let srCleared = true
        if (await isCloudflareBlocked(page)) {
          console.log(`[jmcomic] Search page triggered CF, waiting...`)
          srCleared = false
          for (let w = 0; w < 10; w++) {
            await new Promise((r) => setTimeout(r, 2000))
            if (!(await isCloudflareBlocked(page))) {
              srCleared = true
              console.log(`[jmcomic] Search page CF cleared after ${(w + 1) * 2}s`)
              break
            }
          }
        }

        if (!srCleared) {
          console.warn(`[jmcomic] Search page CF did not clear on ${mirror}`)
          continue
        }

        const srInfo = await page.evaluate(() => ({
          title: document.title,
          url: location.href.substring(0, 120),
          textLen: document.body?.innerText?.length || 0,
          photoLinks: document.querySelectorAll('a[href*="/photo/"]').length,
        }))
        console.log(`[jmcomic] Search page: "${srInfo.title}" url=${srInfo.url} textLen=${srInfo.textLen} photos=${srInfo.photoLinks}`)

        // Dismiss adult overlay if present
        await page.evaluate(() => {
          for (const btn of document.querySelectorAll('button, a.btn, [class*="confirm"], [class*="agree"]')) {
            if (/confirm|agree|enter|18|adult|yes|enter\s*>/i.test(btn.textContent || '')) {
              btn.click()
              break
            }
          }
        })
        await new Promise((r) => setTimeout(r, 2000))

        // Step 5: Parse search results
        const results = await page.evaluate((baseDomain) => {
          const items = []
          const seen = new Set()
          // Search results use /album/ links, each result is a .thumb-overlay containing an <a> tag
          document.querySelectorAll('.thumb-overlay a, a[href*="/album/"]').forEach((el) => {
            const href = el.getAttribute('href') || el.href || ''
            if (!/\/album\/\d+/.test(href)) return
            if (seen.has(href)) return
            seen.add(href)
            // Title from img alt attribute or the link's text
            const title =
              el.querySelector('img')?.alt?.trim() ||
              el.textContent?.trim() || ''
            if (title.length < 2) return
            // Snippet from parent card description/tag
            const card = el.closest('.thumb-overlay')
            const snippet = card?.querySelector('.tag, .tags, .description, p')?.textContent?.trim().substring(0, 200) || ''
            const url = href.startsWith('http') ? href : `${baseDomain}${href.startsWith('/') ? '' : '/'}${href}`
            items.push({ title, url, snippet })
          })
          return items
        }, mirror.replace(/\/+$/, ''))

        if (results.length > 0) {
          console.log(`[jmcomic] ${mirror} returned ${results.length} results`)
          return results
        }
        console.log(`[jmcomic] ${mirror} returned 0 results, trying next mirror...`)
      } catch (err) {
        console.warn(`[jmcomic] ${mirror} error: ${err.message}`)
        continue
      }
    }

    console.log('[jmcomic] All mirrors exhausted, no results found')
    return []
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

    const chapters = await page.evaluate(() => {
      const EXCLUDE_TITLES = ['開始閱讀', '开始阅读', '分頁閱讀', '分页阅读', '評論', '评论', '留言']

      const links = document.querySelectorAll(
        'a[href*="photo/"], ul.list-group a, .list-group-item a, .chapter-list li a, .episode-list a, a[href*="/photo/"]',
      )

      const results = []
      links.forEach((el) => {
        const title = el.textContent.trim()
        if (!title || title.length < 2) return
        if (EXCLUDE_TITLES.some((t) => title.includes(t))) return
        if (!el.href.includes('/photo/')) return
        results.push({ title, url: el.href })
      })

      return results
    })

    const seen = new Set()
    const unique = chapters.filter((ch) => {
      if (seen.has(ch.url)) return false
      seen.add(ch.url)
      return true
    }).map((ch, i) => ({ ...ch, index: i }))

    console.log(`[jmcomic] Found ${unique.length} chapters (filtered from ${chapters.length})`)
    return unique
  }

  async search(browser, keyword) {
    console.log(`[jmcomic] search(browser) keyword="${keyword}"`)
    const page = await browser.newPage()
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      )
      await page.setViewport({ width: 1366, height: 768 })
      return await this.searchByPage(page, keyword)
    } finally {
      await page.close()
    }
  }

  async getPageImages(page) {
    console.log('[jmcomic] Fetching page images...')

    await page.waitForSelector('img', { timeout: 15000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))

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
        const src =
          img.getAttribute('data-original') ||
          img.getAttribute('data-src') ||
          img.getAttribute('src') ||
          ''

        if (!src) return
        if (src.startsWith('data:')) return

        const skipPatterns = ['avatar', 'icon', 'logo', 'banner', 'header', 'footer', 'thumb', 'cover', 'qr', 'button', 'loading', 'spinner']
        if (skipPatterns.some((p) => src.toLowerCase().includes(p))) return

        const url = src.startsWith('//') ? `https:${src}` : src
        if (!url.startsWith('http')) return

        urls.push({ pageNo: urls.length + 1, imageUrl: url })
      })

      if (urls.length === 0) {
        const scripts = document.querySelectorAll('script')
        for (const script of scripts) {
          const text = script.textContent || ''
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
