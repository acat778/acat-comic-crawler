export default {
  server: {
    port: parseInt(process.env.PORT, 10) || 8006,
  },

  crawler: {
    downloadDir: process.env.DOWNLOAD_DIR || './downloads',
    dataDir: process.env.DATA_DIR || './data',
    concurrency: parseInt(process.env.CRAWLER_CONCURRENCY, 10) || 2,
    requestDelay: parseInt(process.env.REQUEST_DELAY, 10) || 2000,
  },

  jmcomic: {
    baseUrl: 'https://18comic.vip',
    defaultAdult: true,
  },

  google: {
    searchUrl: 'https://www.google.com/search',
  },
}
