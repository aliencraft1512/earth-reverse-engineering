
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const MetadataManager = require('./MetadataManager');
const CoverageIndexStore = require('./CoverageIndexStore');
const { decryptXOR, fetchFirstSuccessfulBuffer } = require('./metadata');
const { latLonToPath, slippyTileToCenter } = require('./pathUtils');

const REQUEST_HEADERS = MetadataManager.REQUEST_HEADERS;
const TILE_BASE_URLS = MetadataManager.BASE_URLS;
const DEFAULT_BASE_URL = MetadataManager.BASE_URL_DEFAULT;
const TRANSPARENT_PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9Y9l9QAAAABJRU5ErkJggg==', 'base64');

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

class TileService {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.tileCacheDir = path.join(projectDir, 'tile_cache');
    this.oldDbRootPath = path.join(projectDir, 'old_dbroot.v5');
    this.secretKey = null;
    this.manager = options.manager || new MetadataManager(projectDir);
    this.coverageIndex = options.coverageIndex || new CoverageIndexStore({ rootDir: path.join(projectDir, 'workspace', 'coverage') });
    fs.ensureDirSync(this.tileCacheDir);
  }

  async init() {
    if (!this.manager.catalog) {
      await this.manager.init();
    }
    if (!this.secretKey) this.loadOldSecretKey();
  }

  loadOldSecretKey() {
    this.secretKey = fs.readFileSync(this.oldDbRootPath);
    return this.secretKey;
  }

  decryptTile(buffer) {
    if (!this.secretKey) throw new Error('old_dbroot.v5 is not loaded');
    return decryptXOR(buffer, this.secretKey);
  }

  cachePathForUrl(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return path.join(this.tileCacheDir, `${hash}.jpg`);
  }

  async fetchAndCacheTile(tileUrl) {
    const cachePath = this.cachePathForUrl(tileUrl);
    if (await fs.pathExists(cachePath)) {
      const buffer = await fs.readFile(cachePath);
      return { ok: true, fromCache: true, buffer, cachePath, tileUrl };
    }

    const response = await fetchFirstSuccessfulBuffer({
      baseUrls: TILE_BASE_URLS,
      buildUrl: () => tileUrl,
      headers: REQUEST_HEADERS,
      timeoutMs: 15000,
      validateStatus: status => status === 200,
    });

    const decrypted = this.decryptTile(response.buffer);
    if (!isJpeg(decrypted)) {
      const error = new Error('Decrypted tile is not a JPEG');
      error.status = 502;
      error.tileUrl = response.url || tileUrl;
      error.cachePath = cachePath;
      throw error;
    }

    await fs.writeFile(cachePath, decrypted);
    return { ok: true, fromCache: false, buffer: decrypted, cachePath, tileUrl: response.url || tileUrl };
  }

  buildTileUrl(pathCode, entry) {
    const baseUrl = entry.base_url || DEFAULT_BASE_URL;
    return `${baseUrl}&f1-${pathCode}-i.${entry.iCode}-${entry.fToken}`;
  }

  buildTileCandidates(pathCode, entry, options = {}) {
    const allowSourceFallback = Boolean(options.allowSourceFallback);
    const candidates = [{ pathCode, tileUrl: this.buildTileUrl(pathCode, entry), candidateType: 'requestedPath' }];
    if (allowSourceFallback && entry.sourcePath && entry.sourcePath !== pathCode) {
      candidates.push({
        pathCode: entry.sourcePath,
        tileUrl: this.buildTileUrl(entry.sourcePath, entry),
        candidateType: 'sourcePath',
      });
    }
    return candidates;
  }

  async fetchAndCacheTileForEntry(pathCode, entry, options = {}) {
    const attempts = [];
    let lastError = null;

    for (const candidate of this.buildTileCandidates(pathCode, entry, options)) {
      try {
        const result = await this.fetchAndCacheTile(candidate.tileUrl);
        return {
          ...result,
          usedPathCode: candidate.pathCode,
          requestedPathCode: pathCode,
          candidateType: candidate.candidateType,
          exactPathMatch: candidate.pathCode === pathCode,
          attempts,
        };
      } catch (error) {
        attempts.push({
          pathCode: candidate.pathCode,
          tileUrl: error.tileUrl || candidate.tileUrl,
          statusCode: error.status || null,
          error: error.message,
          candidateType: candidate.candidateType,
        });
        lastError = error;
      }
    }

    const error = new Error(lastError ? lastError.message : 'No tile candidate succeeded');
    error.status = lastError?.status || 404;
    error.tileUrl = lastError?.tileUrl || null;
    error.cachePath = lastError?.cachePath || null;
    error.usedPathCode = null;
    error.attempts = attempts;
    throw error;
  }

  async resolveUnifiedEntry({ pathCode, date, iCode }) {
    if (typeof this.coverageIndex.resolveEntry === 'function') {
      const fromIndex = await this.coverageIndex.resolveEntry(pathCode, date, iCode);
      if (fromIndex) {
        return {
          ...fromIndex,
          base_url: fromIndex.base_url || DEFAULT_BASE_URL,
        };
      }
    }
    return this.manager.resolveLayerEntryForPath(pathCode, date, iCode);
  }

  async getUnifiedTile({ date, iCode, z, x, y, allowSourceFallback = false }) {
    await this.init();
    const center = slippyTileToCenter(z, x, y);
    const pathCode = latLonToPath(center.lat, center.lon, z);
    const entry = await this.resolveUnifiedEntry({ date, iCode, pathCode });

    if (!entry) {
      return {
        ok: false,
        status: 404,
        contentType: 'image/png',
        buffer: TRANSPARENT_PNG_1X1,
        reason: 'No logical layer entry matched this tile path',
      };
    }

    try {
      const result = await this.fetchAndCacheTileForEntry(pathCode, entry, { allowSourceFallback });
      return {
        ok: true,
        status: 200,
        contentType: 'image/jpeg',
        buffer: result.buffer,
        cachePath: result.cachePath,
        tileUrl: result.tileUrl,
        pathCode,
        resolvedPathCode: result.usedPathCode || pathCode,
        exactPathMatch: Boolean(result.exactPathMatch),
        candidateType: result.candidateType,
        attempts: result.attempts || [],
        entry,
      };
    } catch (error) {
      return {
        ok: false,
        status: error.status || 404,
        contentType: 'image/png',
        buffer: TRANSPARENT_PNG_1X1,
        reason: error.message,
        pathCode,
        attempts: error.attempts || [],
        entry,
      };
    }
  }
}

module.exports = TileService;