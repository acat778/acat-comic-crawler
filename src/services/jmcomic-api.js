/**
 * JMComic (禁漫天堂) Mobile API Client
 *
 * Uses the same encrypted API as the official mobile app.
 * Built from reverse-engineered SDK: https://github.com/delta-comic/jmcomic-sdk
 * and web client: https://github.com/TunaFish2K/jmcomic-web-client
 *
 * The API bypasses Cloudflare because it uses custom authentication headers
 * that mimic the official mobile app.
 */
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import axios from 'axios'

const SECRETS = {
  // Used for initial /setting call
  app: '18comicAPP',
  appData: '185Hcomic3PAPP7R',
  content: '18comicAPPContent',
  domain: 'diosfjckwpqpdfjkvnqQjsik',
}

const DOMAIN_SERVERS = [
  'https://rup4a04-c01.tos-ap-southeast-1.bytepluses.com/newsvr-2025.txt',
  'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt',
]

const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 9; V1938CT Build/PQ3A.190705.11211812; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36'
const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

/** AES-ECB decrypt with PKCS#7 unpadding (supports 128/256 based on key length) */
function aesEcbDecrypt(encryptedBase64, keyStr) {
  // keyStr is a UTF-8 string. Its byte length determines AES variant.
  const key = Buffer.from(keyStr, 'utf8')
  const algorithm = key.length === 16 ? 'aes-128-ecb' : (key.length === 32 ? 'aes-256-ecb' : null)
  if (!algorithm) throw new Error(`Invalid key length: ${key.length}`)
  const encrypted = Buffer.from(encryptedBase64, 'base64')
  const decipher = crypto.createDecipheriv(algorithm, key, null)
  decipher.setAutoPadding(false)
  let decrypted = decipher.update(encrypted)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  // PKCS#7 unpadding
  const padLen = decrypted[decrypted.length - 1]
  if (padLen > 0 && padLen <= 16) {
    decrypted = decrypted.subarray(0, decrypted.length - padLen)
  }
  return decrypted.toString('utf8')
}

/** MD5 hex hash */
function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

/**
 * Fetch domain list from the fork server and decrypt it.
 * Returns array of API domain hostnames (e.g., ["18comic.vip", "18comic.ink", ...])
 */
async function fetchDomains() {
  const serverUrl = DOMAIN_SERVERS[Math.floor(Math.random() * DOMAIN_SERVERS.length)]
  console.log(`[JMAPI] Fetching domains from ${serverUrl}`)
  const resp = await axios.get(serverUrl, {
    timeout: 10000,
    httpAgent,
    httpsAgent,
    headers: { 'User-Agent': UA_ANDROID },
  })
  const encrypted = resp.data?.trim()
  if (!encrypted) throw new Error('Empty domain server response')

  // Decrypt: AES-ECB with MD5(secret) as key
  const key = md5(SECRETS.domain)
  const decrypted = aesEcbDecrypt(encrypted, key)
  const obj = JSON.parse(decrypted)
  const domains = obj.Server
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('No domains returned from server')
  }
  console.log(`[JMAPI] Got ${domains.length} domains: ${domains.slice(0, 3).join(', ')}...`)
  return domains
}

/**
 * Initialize API client: picks a fast domain, gets version + cookies from /setting.
 */
export async function initClient() {
  const domains = await fetchDomains()
  let lastErr

  for (const host of domains) {
    const baseURL = `https://${host}`
    console.log(`[JMAPI] Trying ${baseURL}...`)
    try {
      const timestamp = Date.now()
      const url = `${baseURL}/setting`
      const resp = await axios.get(url, {
        timeout: 10000,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': UA_ANDROID,
          'Accept-Encoding': 'gzip, deflate',
          'token': md5(`${Math.floor(timestamp / 1000)}${SECRETS.app}`),
          'tokenparam': `${Math.floor(timestamp / 1000)},2.0.16`,
        },
      })

      // Get cookies from response
      const setCookieHeaders = resp.headers['set-cookie']
      const cookie = Array.isArray(setCookieHeaders) ? setCookieHeaders.join('; ') : (setCookieHeaders || '')

      // Decrypt response data
      const body = resp.data
      if (!body || !body.data) throw new Error('No data in /setting response')

      const decrypted = aesEcbDecrypt(body.data, md5(`${Math.floor(timestamp / 1000)}${SECRETS.appData}`))
      const settings = JSON.parse(decrypted)
      const version = settings.version
      const imageBaseURL = settings.img_host

      console.log(`[JMAPI] Connected to ${host}: version=${version}`)
      return new JmApiClient(baseURL, version, imageBaseURL, cookie)
    } catch (err) {
      console.warn(`[JMAPI] ${host} failed: ${err.message}`)
      lastErr = err
    }
  }

  throw new Error(`All domains failed: ${lastErr?.message}`)
}

class JmApiClient {
  constructor(baseURL, version, imageBaseURL, cookie) {
    this.baseURL = baseURL
    this.version = version
    this.imageBaseURL = imageBaseURL
    this.cookie = cookie
  }

  /** Make an authenticated API call to the JMComic API */
  async call(path, params = {}) {
    const timestamp = Math.floor(Date.now() / 1000)
    const url = new URL(path, this.baseURL)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v))
    }

    const resp = await axios.get(url.toString(), {
      timeout: 15000,
      httpAgent,
      httpsAgent,
      headers: {
        'User-Agent': UA_ANDROID,
        'Accept-Encoding': 'gzip, deflate',
        'token': md5(`${timestamp}${SECRETS.app}`),
        'tokenparam': `${timestamp},${this.version}`,
        'Cookie': this.cookie,
      },
    })

    const body = resp.data
    if (!body || !body.data) {
      throw new Error(`Empty response from ${path}`)
    }

    // Try to decrypt with appData key first, then content key
    let decrypted
    const keys = [
      md5(`${timestamp}${SECRETS.appData}`),
      md5(`${timestamp}${SECRETS.content}`),
    ]
    for (const key of keys) {
      try {
        decrypted = aesEcbDecrypt(body.data, key)
        JSON.parse(decrypted) // verify it's valid JSON
        break
      } catch {
        continue
      }
    }

    if (!decrypted) throw new Error('Failed to decrypt API response')

    return JSON.parse(decrypted)
  }

  /** Search albums. Returns { search_query, total, content: [{ id, author, name }] } */
  async search(keyword, options = {}) {
    const { mainTag = 0, orderBy = 'mr', time = 'a', page = 1 } = options
    return this.call('/search', {
      search_query: keyword,
      main_tag: mainTag,
      o: orderBy,
      t: time,
      page,
    })
  }

  /** Get album details. Returns { id, name, images, author, tags, ... } */
  async getAlbum(id) {
    return this.call('/album', { id })
  }

  /** Get chapter page images. Returns { id, name, images: string[] } */
  async getChapter(id) {
    return this.call('/chapter', { id })
  }

  /** Get scramble ID for image decryption */
  async getScrambleId(chapterId) {
    const timestamp = Math.floor(Date.now() / 1000)
    const url = `${this.baseURL}/chapter_view_template?id=${chapterId}&mode=vertical&page=0&app_img_shunt=1&v=${timestamp}`
    const resp = await axios.get(url, {
      timeout: 10000,
      httpAgent,
      httpsAgent,
      headers: {
        'User-Agent': UA_ANDROID,
        'token': md5(`${timestamp}${SECRETS.content}`),
        'tokenparam': `${timestamp},${this.version}`,
        'Cookie': this.cookie,
      },
    })
    const text = resp.data
    const m = text.match(/var scramble_id\s*=\s*(\d+)/)
    if (!m) throw new Error('scramble_id not found in chapter_view_template')
    return parseInt(m[1])
  }
}

export { JmApiClient }
export default initClient
