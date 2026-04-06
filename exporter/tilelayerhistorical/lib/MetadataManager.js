const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const { HistoricalCatalog } = require('./catalog');
const { buildPathCellsForBounds } = require('./pathUtils');

const BASE_URL_DEFAULT = 'https://khmdb.google.com/flatfile?db=tm';
const BASE_URLS = [
  'https://khmdb.google.com/flatfile?db=tm',
  'https://kh.google.com/flatfile?db=tm',
];

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

const DBROOT_URL = 'https://kh.google.com/dbRoot.v5?hl=el&gl=cy&output=proto&cv=7.3.6.10201&ct=pro';
const MIN_TILE_DEPTH = 4;

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: value >>> 0, next: pos };
    }
    shift += 7;
    if (shift > 35) break;
  }

  return null;
}

function extractRawXorKey(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;

  const exactCandidates = [];
  const looseCandidates = [];

  let i = 0;
  while (i < raw.length) {
    const tagInfo = readVarint(raw, i);
    if (!tagInfo) break;

    const tag = tagInfo.value;
    const wireType = tag & 0x07;
    const fieldNumber = tag >> 3;
    let pos = tagInfo.next;

    if (wireType === 2) {
      const lenInfo = readVarint(raw, pos);
      if (!lenInfo) break;

      const len = lenInfo.value;
      const start = lenInfo.next;
      const end = start + len;

      if (end > raw.length) break;

      const chunk = raw.subarray(start, end);

      if (len === 1016) {
        exactCandidates.push({ fieldNumber, chunk });
      } else if (len >= 1010 && len <= 1040) {
        looseCandidates.push({ fieldNumber, chunk: chunk.subarray(0, 1016) });
      }

      i = end;
      continue;
    }

    if (wireType === 0) {
      const v = readVarint(raw, pos);
      if (!v) break;
      i = v.next;
      continue;
    }

    if (wireType === 1) {
      i = pos + 8;
      continue;
    }

    if (wireType === 5) {
      i = pos + 4;
      continue;
    }

    break;
  }

  const preferredExact = exactCandidates.find(c => c.fieldNumber === 2);
  if (preferredExact) return preferredExact.chunk;
  if (exactCandidates.length > 0) return exactCandidates[0].chunk;

  const preferredLoose = looseCandidates.find(c => c.fieldNumber === 2);
  if (preferredLoose) return preferredLoose.chunk;
  if (looseCandidates.length > 0) return looseCandidates[0].chunk;

  const marker = Buffer.from([0x12, 0xf8, 0x07]);
  const idx = raw.indexOf(marker);
  if (idx !== -1 && idx + 3 + 1016 <= raw.length) {
    return raw.subarray(idx + 3, idx + 3 + 1016);
  }

  return null;
}

function buildExpandedKey(rawKey) {
  if (!rawKey || rawKey.length < 1016) return null;
  return Buffer.concat([Buffer.alloc(8), rawKey.subarray(0, 1016)]);
}

class MetadataManager {
  constructor(workDir, options = {}) {
    this.workDir = workDir;
    this.cacheDir = path.join(workDir, 'cache');
    this.metadataCacheDir = path.join(this.cacheDir, 'metadata');
    this.probeDir = path.join(workDir, 'workspace', 'probe');
    this.metadataDbRootPath = path.join(workDir, 'dbRoot.v5');
    this.metadataProbeKeyPath = path.join(this.probeDir, 'dbroot_field_2.bin');
    this.metadataKey = null;
    this.catalog = null;
    this.dateVersionMapping = {};
    this.baseUrls = options.baseUrls || BASE_URLS;
    this._memCache = new Map(); // LRU RAM cache for qp-*.json payloads
    fs.ensureDirSync(this.cacheDir);
    fs.ensureDirSync(this.metadataCacheDir);
    fs.ensureDirSync(this.probeDir);
  }

  async init() {
    const ok = await this.refreshDbRoot();
    if (!ok) throw new Error('Unable to initialize metadata XOR key');
    this.catalog = new HistoricalCatalog({
      baseUrls: this.baseUrls,
      rootVersion: 366,
      secretKey: this.metadataKey,
      requestHeaders: REQUEST_HEADERS,
      metadataCacheDir: this.metadataCacheDir,
    });
    return true;
  }

  normalizeEntry(entry, defaultSourcePath = null) {
    const iCode = Number.parseInt(entry.iCode ?? entry.version ?? entry.v, 10);
    const fToken = entry.fToken ?? entry.hex_code ?? entry.token ?? '';
    const base_url = entry.base_url ?? entry.baseUrl ?? BASE_URL_DEFAULT;

    return {
      date: entry.date,
      iCode,
      fToken,
      base_url,
      sourcePath: entry.sourcePath || defaultSourcePath || null,
      pathCount: Number.isFinite(entry.pathCount) ? entry.pathCount : undefined,
      duplicateCandidate: entry.duplicateCandidate || undefined,
      paths: Array.isArray(entry.paths) ? entry.paths : undefined,
      sourcePaths: Array.isArray(entry.sourcePaths) ? entry.sourcePaths : undefined,
    };
  }

  applyMetadataPostProcessing(result, defaultSourcePath = null) {
    const safe = result || {};
    const sourcePath = safe.sourcePath || defaultSourcePath || null;

    safe.entries = (safe.entries || [])
      .map(entry => this.normalizeEntry(entry, sourcePath))
      .filter(entry => entry.date && Number.isFinite(entry.iCode) && entry.fToken);

    if (sourcePath && !safe.sourcePath) {
      safe.sourcePath = sourcePath;
    }

    for (const entry of safe.entries) {
      const existing = this.dateVersionMapping[entry.date];
      if (!existing || Number(entry.iCode || 0) > Number(existing.iCode || 0)) {
        this.dateVersionMapping[entry.date] = {
          iCode: entry.iCode,
          fToken: entry.fToken,
          base_url: entry.base_url,
          sourcePath: entry.sourcePath || sourcePath || null,
        };
      }
    }

    return safe;
  }

  async loadMetadataKeyFromLocal() {
    try {
      if (fs.existsSync(this.metadataProbeKeyPath)) {
        const rawKey = fs.readFileSync(this.metadataProbeKeyPath);
        const expanded = buildExpandedKey(rawKey);
        if (expanded) {
          this.metadataKey = expanded;
          return true;
        }
      }

      if (fs.existsSync(this.metadataDbRootPath)) {
        const rawDbRoot = fs.readFileSync(this.metadataDbRootPath);
        const rawKey = extractRawXorKey(rawDbRoot);
        const expanded = buildExpandedKey(rawKey);
        if (expanded) {
          fs.writeFileSync(this.metadataProbeKeyPath, rawKey);
          this.metadataKey = expanded;
          return true;
        }
      }
    } catch (error) {
      console.warn('[MetadataManager] local key load failed:', error.message);
    }

    return false;
  }

  async refreshMetadataDbRoot() {
    try {
      const res = await axios.get(DBROOT_URL, {
        responseType: 'arraybuffer',
        headers: REQUEST_HEADERS,
        timeout: 12000,
      });

      const raw = Buffer.from(res.data);
      const rawKey = extractRawXorKey(raw);
      const expanded = buildExpandedKey(rawKey);
      if (!expanded) throw new Error('Failed to extract metadata XOR key from remote dbRoot');

      fs.writeFileSync(this.metadataDbRootPath, raw);
      fs.writeFileSync(this.metadataProbeKeyPath, rawKey);
      this.metadataKey = expanded;
      return true;
    } catch (error) {
      console.warn('[MetadataManager] remote dbRoot refresh failed, falling back to local:', error.message);
      return this.loadMetadataKeyFromLocal();
    }
  }

  async refreshDbRoot() {
    return this.refreshMetadataDbRoot();
  }

  async tryFetchMetadataForPath(pathCode) {
    if (this._memCache.has(pathCode)) {
      return this._memCache.get(pathCode);
    }

    const cacheFile = path.join(this.metadataCacheDir, `qp-${pathCode}.json`);

    if (fs.existsSync(cacheFile)) {
      const cached = await fs.readJson(cacheFile);
      const patched = this.applyMetadataPostProcessing(cached, pathCode);
      this._memCache.set(pathCode, patched);
      return patched;
    }

    if (!this.catalog) {
      throw new Error('Metadata catalog is not initialized');
    }

    try {
      const result = await this.catalog.fetchMetadataForPath(pathCode);
      const patched = this.applyMetadataPostProcessing(result, pathCode);
      await fs.writeJson(cacheFile, patched, { spaces: 2 });
      this._memCache.set(pathCode, patched);
      return patched;
    } catch (error) {
      // Short-circuit: cache the empty 404 in memory so we don't spam Google with redundant fallback requests
      this._memCache.set(pathCode, null);
      return null;
    }
  }

  async fetchMetadata(pathCode) {
    // TOP-DOWN SHORT CIRCUIT
    // If any parent quadtree node was already proven to contain zero data (404),
    // it is mathematically guaranteed the children have no data. Bypassing network!
    for (let len = 4; len < pathCode.length; len += 1) {
      const parent = pathCode.slice(0, len);
      if (this._memCache.has(parent) && this._memCache.get(parent) === null) {
        const emptyResult = this.applyMetadataPostProcessing({
          requestedPath: pathCode,
          sourcePath: pathCode,
          entries: [],
        }, pathCode);
        this._memCache.set(pathCode, emptyResult);
        return emptyResult;
      }
    }

    const tried = new Set();

    for (let len = pathCode.length; len >= MIN_TILE_DEPTH; len -= 1) {
      const candidate = pathCode.slice(0, len);
      if (tried.has(candidate)) continue;
      tried.add(candidate);

      const result = await this.tryFetchMetadataForPath(candidate);
      if (result && Array.isArray(result.entries) && result.entries.length > 0) {
        if (candidate !== pathCode) {
          const alias = {
            ...result,
            requestedPath: pathCode,
            sourcePath: result.sourcePath || candidate,
          };
          const aliasCacheFile = path.join(this.metadataCacheDir, `qp-${pathCode}.json`);
          await fs.writeJson(aliasCacheFile, alias, { spaces: 2 });
          const patchedAlias = this.applyMetadataPostProcessing(alias, pathCode);
          this._memCache.set(pathCode, patchedAlias);
          return patchedAlias;
        }

        const patchedResult = this.applyMetadataPostProcessing(result, pathCode);
        this._memCache.set(pathCode, patchedResult);
        return patchedResult;
      }
    }

    const emptyResult = this.applyMetadataPostProcessing({
      requestedPath: pathCode,
      sourcePath: pathCode,
      entries: [],
    }, pathCode);
    this._memCache.set(pathCode, emptyResult);
    return emptyResult;
  }

  async buildBoundsCatalog(bounds, zoom) {
    if (!this.catalog) throw new Error('Metadata catalog is not initialized');
    const summary = await this.catalog.buildBoundsCatalog(bounds, zoom);
    summary.entries = (summary.entries || []).map(entry => this.normalizeEntry(entry));
    return summary;
  }

  async discoverLogicalLayers(bounds, zoom) {
    const summary = await this.buildBoundsCatalog(bounds, zoom);
    const byLayer = new Map();

    for (const entry of summary.entries || []) {
      const key = `${entry.date}|${entry.iCode}`;
      if (!byLayer.has(key)) {
        byLayer.set(key, {
          id: key,
          date: entry.date,
          iCode: entry.iCode,
          entryCount: 0,
          pathCount: 0,
          fTokens: new Set(),
          sourcePaths: new Set(),
          duplicateCandidate: false,
        });
      }

      const layer = byLayer.get(key);
      layer.entryCount += 1;
      layer.pathCount += Number.isFinite(entry.pathCount) ? entry.pathCount : 0;
      if (entry.fToken) layer.fTokens.add(entry.fToken);
      for (const sourcePath of entry.sourcePaths || []) {
        if (sourcePath) layer.sourcePaths.add(sourcePath);
      }
      if (entry.duplicateCandidate) layer.duplicateCandidate = true;
    }

    const layers = [...byLayer.values()].map(layer => ({
      ...layer,
      fTokens: [...layer.fTokens].sort(),
      sourcePaths: [...layer.sourcePaths].sort(),
      tokenCount: layer.fTokens.size,
      sourcePathCount: layer.sourcePaths.size,
    })).sort((a, b) => {
      if (a.date === b.date) return b.iCode - a.iCode;
      return b.date.localeCompare(a.date);
    });

    return {
      bounds: summary.bounds,
      zoom: summary.zoom,
      verification: summary.verification,
      layers,
      rawEntries: summary.entries,
      paths: summary.paths,
    };
  }

  async fetchAvailableDatesInBounds(bounds, zoom) {
    const summary = await this.discoverLogicalLayers(bounds, zoom);
    return summary.layers;
  }

  async resolveLayerEntryForPath(pathCode, date, iCode) {
    const metadata = await this.fetchMetadata(pathCode);
    const matches = (metadata.entries || []).filter(entry => entry.date === date && Number(entry.iCode) === Number(iCode));
    if (!matches.length) {
      return null;
    }

    matches.sort((left, right) => {
      const leftSource = String(left.sourcePath || metadata.sourcePath || '');
      const rightSource = String(right.sourcePath || metadata.sourcePath || '');
      if (leftSource.length !== rightSource.length) return rightSource.length - leftSource.length;
      if (left.base_url !== right.base_url) {
        if (left.base_url === BASE_URL_DEFAULT) return -1;
        if (right.base_url === BASE_URL_DEFAULT) return 1;
      }
      return String(left.fToken).localeCompare(String(right.fToken));
    });

    return {
      ...matches[0],
      sourcePath: matches[0].sourcePath || metadata.sourcePath || pathCode,
      requestedPath: pathCode,
    };
  }
}

MetadataManager.BASE_URLS = BASE_URLS;
MetadataManager.BASE_URL_DEFAULT = BASE_URL_DEFAULT;
MetadataManager.REQUEST_HEADERS = REQUEST_HEADERS;

module.exports = MetadataManager;
