export default {
  server: {
    port: parseInt(process.env.PORT, 10) || 8619,
  },

  crawler: {
    downloadDir: process.env.DOWNLOAD_DIR || './downloads',
    dataDir: process.env.DATA_DIR || './data',
    concurrency: parseInt(process.env.CRAWLER_CONCURRENCY, 10) || 2,
    requestDelay: parseInt(process.env.REQUEST_DELAY, 10) || 2000,
    apiBaseUrl: process.env.CRAWLER_API_BASE_URL || 'http://localhost:9650/api/comic/crawler',
  },

  jmcomic: {
    baseUrl: 'https://18comic.vip',
    mirrors: [
      'https://18comic.vip',
      'https://18comic.ink',
      'https://jmcomic-zzz.one',
      'https://jmcomic-zzz.org',
      'https://comic18j-codi.cc',
      'https://comic18j-yodo.club',
      'https://comic18j-codi.club',
    ],
    defaultAdult: true,
  },
}
