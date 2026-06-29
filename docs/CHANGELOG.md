# Changelog

## 2026-06-30 — JMComic Mobile API Integration

- Added `src/services/jmcomic-api.js`: JMComic (禁漫天堂) mobile API client with AES-ECB encryption that bypasses Cloudflare.
- Rewrote `crawlerService.search()` to use JMComic API (fast, structured JSON, no Puppeteer needed).
- Added `runApiTask()`: API-based album crawl with CDN image download (no Cloudflare issues).
- Updated `src/routes/crawler.js`: Added 90s timeout guard on search endpoint.
- Updated `src/config.js`: Added all 7 mirror domains for 禁漫天堂.
- Added `axios` and `cheerio` npm dependencies for API client and fallback search parsing.
- The adapter pattern (`SiteAdapter`) is preserved; JMComic API is used as the primary path, Puppeteer/scraping remains as fallback.

### Key improvements
- **Search**: 80 results per query, <5s response time (vs. Puppeteer + Cloudflare which returned 0 results).
- **Crawl**: Images downloaded directly from CDN via HTTP (vs. Puppeteer navigation which got blocked by Cloudflare).
- **No Cloudflare issues**: The mobile API uses official app authentication headers that bypass Cloudflare managed challenge.
- **Reference projects**: https://github.com/delta-comic/jmcomic-sdk, https://github.com/TunaFish2K/jmcomic-web-client
