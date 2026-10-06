const http = require('http');
const https = require('https');

class CacheRefreshService {
  static sendPost(urlStr) {
    if (!urlStr) {
      console.warn('[CacheRefreshService] No URL provided for cache refresh');
      return;
    }

    try {
      console.log(`[CacheRefreshService] Triggering cache refresh at ${urlStr}`);
      const client = urlStr.startsWith('https') ? https : http;
      const req = client.request(urlStr, { method: 'POST' }, (res) => {
        console.log(`[CacheRefreshService] Cache refresh response from ${urlStr}: status ${res.statusCode}`);
        res.on('data', () => {}); // Consume stream to avoid memory leak
      });

      req.on('error', (err) => {
        console.error(`[CacheRefreshService] Cache refresh failed for ${urlStr}:`, err.message);
      });

      req.end();
    } catch (err) {
      console.error(`[CacheRefreshService] Error triggering cache refresh:`, err.message);
    }
  }

  static triggerStandardRefresh() {
    const url = process.env.BILLING_CACHE_REFRESH_URL || 'http://localhost:8005/api/v1/cache/refresh';
    this.sendPost(url);
  }

  static triggerRecordRefresh() {
    const url = process.env.BILLING_REC_CACHE_REFRESH_URL || 'http://localhost:8005/api/v1/cache/refresh-record';
    this.sendPost(url);
  }
}

module.exports = CacheRefreshService;
