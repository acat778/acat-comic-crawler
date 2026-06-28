import puppeteer from 'puppeteer'

let browserInstance = null

export async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance
  }
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  })
  console.log('[Browser] Puppeteer launched')
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

export async function googleSearch(keyword) {
  const page = await newPage()
  try {
    const query = `site:18comic.vip ${keyword}`
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`
    console.log(`[Google] Searching: ${query}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('div.g', { timeout: 10000 }).catch(() => {})

    const results = await page.evaluate(() => {
      const items = []
      document.querySelectorAll('div.g').forEach((el) => {
        const link = el.querySelector('a[href*="18comic.vip"]')
        const title = el.querySelector('h3')
        const snippet = el.querySelector('.VwiC3b, span.aCOpRe, div[data-sncf]')
        if (link) {
          items.push({
            title: title?.textContent || link.textContent || 'Unknown',
            url: link.href,
            snippet: snippet?.textContent || '',
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
