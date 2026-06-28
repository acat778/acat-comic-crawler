import { JmComicAdapter } from './site-18comic.js'
import config from '../config.js'

const adapters = new Map()

function register(adapter) {
  adapters.set(adapter.siteId, adapter)
}

// Register built-in adapters
register(new JmComicAdapter(config.jmcomic))

export function getAdapter(siteId) {
  const adapter = adapters.get(siteId)
  if (!adapter) throw new Error(`Unknown site: ${siteId}`)
  return adapter
}

export function listAdapters() {
  return Array.from(adapters.keys())
}

export { register }
