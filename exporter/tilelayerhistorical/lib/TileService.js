
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const JimpModule = require('jimp');

const MetadataManager = require('./MetadataManager');
const CoverageIndexStore = require('./CoverageIndexStore');
const { decryptXOR, fetchFirstSuccessfulBuffer } = require('./metadata');
const { latLonToPath, slippyTileToCenter } = require('./pathUtils');

const REQUEST_HEADERS = MetadataManager.REQUEST_HEADERS;
const TILE_BASE_URLS = MetadataManager.BASE_URLS;
const DEFAULT_BASE_URL = MetadataManager.BASE_URL_DEFAULT;
const TRANSPARENT_PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9Y9l9QAAAABJRU5ErkJggg==', 'base64');
const TILE_SIZE = 256;
const JimpRead =
  (typeof JimpModule.read === 'function' && JimpModule.read.bind(JimpModule)) ||
  (typeof JimpModule.Jimp?.read === 'function' && JimpModule.Jimp.read.bind(JimpModule.Jimp)) ||
  (typeof JimpModule.default?.read === 'function' && JimpModule.default.read.bind(JimpModule.default));
const JimpMimeJPEG = JimpModule.MIME_JPEG || JimpModule.Jimp?.MIME_JPEG || JimpModule.default?.MIME_JPEG || 'image/jpeg';
const JimpResizeBilinear = JimpModule.RESIZE_BILINEAR || JimpModule.Jimp?.RESIZE_BILINEAR || JimpModule.default?.RESIZE_BILINEAR;

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

async function readJimpImage(buffer) {
  if (!JimpRead) {
    throw new Error('Jimp read() is unavailable in this runtime');
  }
  return JimpRead(buffer);
}

function resizeImage(image, width, height) {
  if (JimpResizeBilinear !== undefined) {
    image.resize(width, height, JimpResizeBilinear);
  } else {
    image.resize(width, height);
  }
  return image;
}

async function createBlankComposite(width, height) {
  const image = await readJimpImage(TRANSPARENT_PNG_1X1);
  return resizeImage(image, width, height);
}

class TileService {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.tileCacheDir = path.join(projectDir, 'tile_cache');
    this.compositeCacheDir = path.join(this.tileCacheDir, 'composite');
    this.oldDbRootPath = path.join(projectDir, 'old_dbroot.v5');
    this.secretKey = null;
    this.manager = options.manager || new MetadataManager(projectDir);
    this.coverageIndex = options.coverageIndex || new CoverageIndexStore({ rootDir: path.join(projectDir, 'workspace', 'coverage') });
    fs.ensureDirSync(this.tileCacheDir);
    fs.ensureDirSync(this.compositeCacheDir);
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

  compositeCachePathForRequest({ date, iCode, z, x, y, sourceZoom, allowSourceFallback }) {
    const key = JSON.stringify({ date, iCode, z, x, y, sourceZoom, allowSourceFallback: !!allowSourceFallback });
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return path.join(this.compositeCacheDir, `${hash}.jpg`);
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

  async getDirectUnifiedTile({ date, iCode, z, x, y, allowSourceFallback = false }) {
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

  async composeFromHigherNativeZoom({ date, iCode, z, x, y, sourceZoom, allowSourceFallback = false }) {
    const scale = Math.pow(2, sourceZoom - z);
    const mosaicSize = TILE_SIZE * scale;
    const mosaic = await createBlankComposite(mosaicSize, mosaicSize);
    let anySuccess = false;
    const childResults = [];

    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const childX = x * scale + dx;
        const childY = y * scale + dy;
        const result = await this.getDirectUnifiedTile({
          date,
          iCode,
          z: sourceZoom,
          x: childX,
          y: childY,
          allowSourceFallback,
        });
        childResults.push({ x: childX, y: childY, ok: result.ok, status: result.status });
        if (!result.ok || !isJpeg(result.buffer)) {
          continue;
        }
        const img = await readJimpImage(result.buffer);
        mosaic.composite(img, dx * TILE_SIZE, dy * TILE_SIZE);
        anySuccess = true;
      }
    }

    if (!anySuccess) {
      return {
        ok: false,
        status: 404,
        contentType: 'image/png',
        buffer: TRANSPARENT_PNG_1X1,
        reason: 'No source tiles available for composite downsample',
        childResults,
      };
    }

    resizeImage(mosaic, TILE_SIZE, TILE_SIZE);
    const buffer = await mosaic.quality(85).getBufferAsync(JimpMimeJPEG);
    return {
      ok: true,
      status: 200,
      contentType: 'image/jpeg',
      buffer,
      childResults,
      composited: true,
      sourceZoom,
    };
  }

  async composeFromLowerNativeZoom({ date, iCode, z, x, y, sourceZoom, allowSourceFallback = false }) {
    const scale = Math.pow(2, z - sourceZoom);
    const parentX = Math.floor(x / scale);
    const parentY = Math.floor(y / scale);
    const offsetX = x % scale;
    const offsetY = y % scale;
    const cropSize = TILE_SIZE / scale;

    const parent = await this.getDirectUnifiedTile({
      date,
      iCode,
      z: sourceZoom,
      x: parentX,
      y: parentY,
      allowSourceFallback,
    });

    if (!parent.ok || !isJpeg(parent.buffer)) {
      return {
        ok: false,
        status: parent.status || 404,
        contentType: 'image/png',
        buffer: TRANSPARENT_PNG_1X1,
        reason: parent.reason || 'No parent tile available for upscale composite',
      };
    }

    const image = await readJimpImage(parent.buffer);
    image.crop(offsetX * cropSize, offsetY * cropSize, cropSize, cropSize);
    resizeImage(image, TILE_SIZE, TILE_SIZE);
    const buffer = await image.quality(85).getBufferAsync(JimpMimeJPEG);
    return {
      ok: true,
      status: 200,
      contentType: 'image/jpeg',
      buffer,
      composited: true,
      sourceZoom,
      parentTile: { z: sourceZoom, x: parentX, y: parentY },
    };
  }

  async getCompositedUnifiedTile({ date, iCode, z, x, y, sourceZoom, allowSourceFallback = false }) {
    const sourceZoomNum = Number(sourceZoom);
    if (!Number.isFinite(sourceZoomNum)) {
      return this.getDirectUnifiedTile({ date, iCode, z, x, y, allowSourceFallback });
    }

    if (sourceZoomNum === z) {
      return this.getDirectUnifiedTile({ date, iCode, z, x, y, allowSourceFallback });
    }

    const cachePath = this.compositeCachePathForRequest({ date, iCode, z, x, y, sourceZoom: sourceZoomNum, allowSourceFallback });
    if (await fs.pathExists(cachePath)) {
      const buffer = await fs.readFile(cachePath);
      return {
        ok: true,
        status: 200,
        contentType: 'image/jpeg',
        buffer,
        cachePath,
        composited: true,
        sourceZoom: sourceZoomNum,
        fromCache: true,
      };
    }

    let result;
    if (sourceZoomNum > z) {
      result = await this.composeFromHigherNativeZoom({ date, iCode, z, x, y, sourceZoom: sourceZoomNum, allowSourceFallback });
    } else {
      result = await this.composeFromLowerNativeZoom({ date, iCode, z, x, y, sourceZoom: sourceZoomNum, allowSourceFallback });
    }

    if (result.ok && isJpeg(result.buffer)) {
      await fs.writeFile(cachePath, result.buffer);
      result.cachePath = cachePath;
      result.fromCache = false;
    }

    return result;
  }

  async getUnifiedTile({ date, iCode, z, x, y, sourceZoom = null, allowSourceFallback = false }) {
    await this.init();
    if (sourceZoom !== null && sourceZoom !== undefined) {
      return this.getCompositedUnifiedTile({ date, iCode, z, x, y, sourceZoom, allowSourceFallback });
    }
    return this.getDirectUnifiedTile({ date, iCode, z, x, y, allowSourceFallback });
  }
}

module.exports = TileService;