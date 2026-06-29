import puppeteer from 'puppeteer'
import axios from 'axios'
import * as cheerio from 'cheerio'

let browserInstance = null
let stealthReady = false

async function initStealth() {
  if (stealthReady) return
  try {
    const { default: puppeteerExtra } = await import('puppeteer-extra')
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth')
    puppeteerExtra.use(StealthPlugin())
    globalThis.__puppeteerExtra = puppeteerExtra
    stealthReady = true
    console.log('[Browser] puppeteer-extra + stealth plugin loaded')
  } catch (err) {
    console.warn('[Browser] stealth plugin failed to load, using native puppeteer:', err.message)
    stealthReady = false
  }
}

function randomViewport() {
  const widths = [1366, 1440, 1536, 1600, 1920]
  const heights = [768, 800, 864, 900, 1080]
  return {
    width: widths[Math.floor(Math.random() * widths.length)],
    height: heights[Math.floor(Math.random() * heights.length)],
  }
}

export async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance
  }

  await initStealth()

  const launchArgs = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--lang=zh-CN',
    ],
  }

  let launcher
  if (globalThis.__puppeteerExtra) {
    launcher = globalThis.__puppeteerExtra
  } else {
    launcher = puppeteer
  }

  browserInstance = await launcher.launch(launchArgs)
  console.log('[Browser] Puppeteer launched' + (stealthReady ? ' with stealth' : ''))
  return browserInstance
}

export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
    console.log('[Browser] Closed')
  }
}

export async function newPage() {
  const browser = await getBrowser()
  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  )
  await page.setViewport({ width: 1366, height: 768 })
  return page
}

/** Create a stealth page with anti-detection measures */
export async function newStealthPage() {
  const browser = await getBrowser()
  const page = await browser.newPage()

  const ua = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ][Math.floor(Math.random() * 3)]

  const viewport = randomViewport()
  await page.setUserAgent(ua)
  await page.setViewport(viewport)

  // DO NOT setExtraHTTPHeaders here — the stealth plugin handles headers
  // and explicit HTTP headers via CDP make the browser more detectable.

  page.setDefaultNavigationTimeout(45000)
  page.setDefaultTimeout(30000)

  return page
}

/**
 * Check if the page is blocked by Cloudflare or a security challenge.
 * Checks both the page title and body text (handles multiple languages).
 */
export async function isCloudflareBlocked(page) {
  try {
    const title = await page.title()
    if (/Just a moment|请稍候|checking your browser|security verification/i.test(title)) return true
    const text = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '')
    return /security verification|Just a moment|checking your browser|检测|cf-browser-verification|Cloudflare|请稍候/i.test(text)
  } catch {
    return false
  }
}

// ==================== DuckDuckGo Search (axios, lightweight) ====================

export async function duckduckgoSearch(keyword, pageNum = 0) {
  const offset = pageNum * 30
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}&s=${offset}`

  console.log(`[DDG] Searching: ${keyword} offset=${offset}`)

  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (s) => s < 500,
    })

    const html = resp.data
    if (!html || html.length < 500) {
      console.warn(`[DDG] Response too short (${html?.length || 0} bytes)`)
      return { results: [], hasMore: false }
    }

    const results = parseDdgResults(html)
    const hasMore = results.length >= 30
    console.log(`[DDG] Found ${results.length} comic results`)
    return { results, hasMore }
  } catch (err) {
    console.warn(`[DDG] Request failed: ${err.message}`)
    return { results: [], hasMore: false }
  }
}

function parseDdgResults(html) {
  const $ = cheerio.load(html)
  const results = []
  const seen = new Set()

  $('a.result__a').each((_i, el) => {
    const $el = $(el)
    const ddgHref = $el.attr('href') || ''

    let targetUrl = ''
    try {
      const urlObj = new URL(ddgHref, 'https://html.duckduckgo.com')
      const uddg = urlObj.searchParams.get('uddg')
      if (uddg) {
        targetUrl = decodeURIComponent(uddg)
      }
    } catch {
      const m = ddgHref.match(/uddg=([^&]+)/)
      if (m) {
        try { targetUrl = decodeURIComponent(m[1]) } catch {}
      }
    }

    if (!targetUrl) return

    const urlLower = targetUrl.toLowerCase()
    const isTarget = JMCOMIC_DOMAINS.some((d) => urlLower.includes(d))
    if (!isTarget) return

    targetUrl = targetUrl.replace(/\/#.*$/, '').replace(/\/$/, '')
    if (seen.has(targetUrl)) return
    seen.add(targetUrl)

    const title = $el.text().trim().substring(0, 200)
    if (!title || title.length < 2) return

    const $parent = $el.closest('td, div')
    let snippet = ''
    if ($parent.length) {
      snippet = $parent.find('.result__snippet').first().text().trim().substring(0, 300)
    }

    results.push({ title, url: targetUrl, snippet })
  })

  return results.slice(0, 30)
}

// ==================== Google Search (Puppeteer, fallback) ====================

export async function googleSearch(keyword) {
  const page = await newStealthPage()
  try {
    const query = `site:18comic.vip ${keyword}`
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`
    console.log(`[Google] Searching: ${query}`)

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Wait up to 15s for any challenge to clear
    for (let w = 0; w < 7; w++) {
      await new Promise((r) => setTimeout(r, 2000))
      const finalUrl = page.url()
      if (!finalUrl.includes('sorry') && !finalUrl.includes('captcha')) break
    }

    await page.waitForSelector('div.g', { timeout: 15000 }).catch(() => {})

    const results = await page.evaluate(() => {
      const domains = ['18comic.vip', '18comic.ink', 'jmcomic-zzz.one', 'jmcomic-zzz.org', 'comic18j-codi.cc', 'comic18j-yodo.club', 'comic18j-codi.club']
      const items = []
      document.querySelectorAll('div.g').forEach((el) => {
        const link = el.querySelector('a')
        const titleEl = el.querySelector('h3')
        const snippetEl = el.querySelector('.VwiC3b, span.aCOpRe, div[data-sncf]')
        if (link) {
          const url = link.href || ''
          if (!domains.some((d) => url.includes(d))) return
          items.push({
            title: titleEl?.textContent || link.textContent || 'Unknown',
            url,
            snippet: snippetEl?.textContent || '',
          })
        }
      })
      return items
    })

    console.log(`[Google] Found ${results.length} results`)
    return results
  } finally {
    await page.close()
  }
}

/** All known mirror domains for 禁漫天堂 (JMComic / 18comic) */
const JMCOMIC_DOMAINS = [
  '18comic.vip', '18comic.ink',
  'jmcomic-zzz.one', 'jmcomic-zzz.org',
  'comic18j-codi.cc', 'comic18j-yodo.club', 'comic18j-codi.club',
]
