/**
 * Abstract site adapter for comic source sites.
 * Each site adapter implements scraping logic for a specific source.
 */
export class SiteAdapter {
  constructor(config) {
    this.config = config
  }

  /** Unique site identifier, e.g. "jmcomic" */
  get siteId() {
    throw new Error('Not implemented: siteId')
  }

  /** Search source site via Google. Returns [{ title, url, snippet }] */
  async search(browser, keyword) {
    throw new Error('Not implemented: search')
  }

  /** Parse album page. Returns { title, author, coverUrl, tags, description, pageCount, defaultAdult } */
  async getAlbumInfo(page, url) {
    throw new Error('Not implemented: getAlbumInfo')
  }

  /** Parse chapter list from album page. Returns [{ title, url, index }] */
  async getChapters(page) {
    throw new Error('Not implemented: getChapters')
  }

  /** Parse image URLs from chapter page. Returns [{ pageNo, imageUrl }] */
  async getPageImages(page) {
    throw new Error('Not implemented: getPageImages')
  }
}
