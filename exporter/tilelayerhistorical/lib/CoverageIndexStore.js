
const fs = require('fs-extra');
const path = require('path');

function entryKey(entry) {
  return `${entry.date}|${entry.iCode}|${entry.fToken}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBounds(bounds) {
  if (!bounds) return null;

  if (Array.isArray(bounds) && bounds.length === 4) {
    const [west, south, east, north] = bounds.map(Number);
    if ([west, south, east, north].every(Number.isFinite)) {
      return { west, south, east, north };
    }
  }

  if (
    typeof bounds === 'object' &&
    Number.isFinite(bounds.west) &&
    Number.isFinite(bounds.south) &&
    Number.isFinite(bounds.east) &&
    Number.isFinite(bounds.north)
  ) {
    return {
      west: Number(bounds.west),
      south: Number(bounds.south),
      east: Number(bounds.east),
      north: Number(bounds.north),
    };
  }

  return null;
}

function bboxPolygon(bounds) {
  const b = normalizeBounds(bounds);
  if (!b) return null;
  return {
    type: 'Polygon',
    coordinates: [[
      [b.west, b.south],
      [b.east, b.south],
      [b.east, b.north],
      [b.west, b.north],
      [b.west, b.south],
    ]],
  };
}

class CoverageIndexStore {
  constructor(options = {}) {
    if (typeof options === 'string') {
      options = { rootDir: path.join(options, 'workspace', 'coverage') };
    }
    this.rootDir = options.rootDir || path.join(process.cwd(), 'workspace', 'coverage');
    this.metadataDir = path.join(this.rootDir, 'metadata_records');
    this.verifyDir = path.join(this.rootDir, 'verified_records');
    this.exportDir = path.join(this.rootDir, 'exports');
    this.indexPath = path.join(this.rootDir, 'coverage_index.json');
  }

  async init() {
    await fs.ensureDir(this.rootDir);
    await fs.ensureDir(this.metadataDir);
    await fs.ensureDir(this.verifyDir);
    await fs.ensureDir(this.exportDir);
  }

  metadataRecordPath(zoom, pathCode) {
    return path.join(this.metadataDir, `z${zoom}`, `${pathCode}.json`);
  }

  async readMetadataRecord(zoom, pathCode) {
    const file = this.metadataRecordPath(zoom, pathCode);
    if (!(await fs.pathExists(file))) return null;
    return fs.readJson(file);
  }

  async writeMetadataRecord(zoom, pathCode, data) {
    const file = this.metadataRecordPath(zoom, pathCode);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, data, { spaces: 2 });
    return file;
  }

  verifyRecordPath(pathCode, entry) {
    const dir = path.join(this.verifyDir, pathCode);
    const safe = entryKey(entry).replace(/[^a-zA-Z0-9._-]+/g, '_');
    return path.join(dir, `${safe}.json`);
  }

  async readVerifyRecord(pathCode, entry) {
    const file = this.verifyRecordPath(pathCode, entry);
    if (!(await fs.pathExists(file))) return null;
    return fs.readJson(file);
  }

  async writeVerifyRecord(pathCode, entry, data) {
    const file = this.verifyRecordPath(pathCode, entry);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, data, { spaces: 2 });
    return file;
  }

  async *iterateMetadataRecords() {
    if (!(await fs.pathExists(this.metadataDir))) return;
    const zoomDirs = await fs.readdir(this.metadataDir);
    for (const zoomName of zoomDirs) {
      const zoomDir = path.join(this.metadataDir, zoomName);
      const stat = await fs.stat(zoomDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      const files = await fs.readdir(zoomDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(zoomDir, file);
        const record = await fs.readJson(full).catch(() => null);
        if (record) yield record;
      }
    }
  }

  async *iterateVerifyRecords() {
    if (!(await fs.pathExists(this.verifyDir))) return;
    const pathDirs = await fs.readdir(this.verifyDir);
    for (const pathCode of pathDirs) {
      const dir = path.join(this.verifyDir, pathCode);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(dir, file);
        const record = await fs.readJson(full).catch(() => null);
        if (record) yield record;
      }
    }
  }

  async buildIndex() {
    await this.init();

    const pathAliases = {};
    const sourceBuckets = {};
    const layers = {};

    for await (const record of this.iterateMetadataRecords()) {
      const entries = ensureArray(record.entries);
      const sourcePath = record.sourcePath || record.path || record.requestedPath;
      const pathCode = record.path || record.requestedPath;
      const zoom = record.zoom;
      const bounds = normalizeBounds(record.bounds);
      if (!pathCode || !sourcePath) continue;

      pathAliases[pathCode] = {
        path: pathCode,
        requestedPath: record.requestedPath || pathCode,
        sourcePath,
        zoom,
        bounds,
        entryCount: entries.length,
      };

      if (!sourceBuckets[sourcePath]) {
        sourceBuckets[sourcePath] = {
          sourcePath,
          entryMap: {},
          pathCount: 0,
        };
      }

      const bucket = sourceBuckets[sourcePath];
      bucket.pathCount += 1;

      for (const entry of entries) {
        const key = entryKey(entry);
        if (!bucket.entryMap[key]) {
          bucket.entryMap[key] = {
            date: entry.date,
            iCode: entry.iCode,
            fToken: entry.fToken,
            base_url: entry.base_url,
            sourcePath: entry.sourcePath || sourcePath,
          };
        }

        const layerKey = `${entry.date}|${entry.iCode}`;
        if (!layers[layerKey]) {
          layers[layerKey] = {
            key: layerKey,
            date: entry.date,
            iCode: entry.iCode,
            sourcePaths: new Set(),
            pathCount: 0,
            verifiedPathCount: 0,
          };
        }
        layers[layerKey].sourcePaths.add(sourcePath);
        layers[layerKey].pathCount += 1;
      }
    }

    const verifySummary = {};
    for await (const verify of this.iterateVerifyRecords()) {
      const layerKey = `${verify.date}|${verify.iCode}`;
      if (!verifySummary[layerKey]) verifySummary[layerKey] = new Set();
      if (verify.verified) verifySummary[layerKey].add(verify.pathCode);
    }

    for (const layer of Object.values(layers)) {
      layer.sourcePaths = Array.from(layer.sourcePaths);
      layer.verifiedPathCount = verifySummary[layer.key] ? verifySummary[layer.key].size : 0;
    }

    const compactSourceBuckets = {};
    for (const [sourcePath, bucket] of Object.entries(sourceBuckets)) {
      compactSourceBuckets[sourcePath] = {
        sourcePath,
        pathCount: bucket.pathCount,
        entries: Object.values(bucket.entryMap),
      };
    }

    const index = {
      generatedAt: new Date().toISOString(),
      pathCount: Object.keys(pathAliases).length,
      sourceBucketCount: Object.keys(compactSourceBuckets).length,
      layerCount: Object.keys(layers).length,
      pathAliases,
      sourceBuckets: compactSourceBuckets,
      layers,
    };

    const writeObjectEntries = (stream, object, indent) => new Promise((resolve, reject) => {
      const entries = Object.entries(object);
      let idx = 0;

      stream.on('error', reject);

      function writeNext() {
        while (idx < entries.length) {
          const [key, value] = entries[idx];
          const prefix = idx === 0 ? '' : ',\n';
          const line = `${prefix}${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`;

          if (!stream.write(line)) {
            idx += 1;
            stream.once('drain', writeNext);
            return;
          }

          idx += 1;
        }

        resolve();
      }

      writeNext();
    });

    const _indexPath = this.indexPath;
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(_indexPath, { encoding: 'utf8' });
      stream.on('error', reject);

      (async () => {
        stream.write('{\n');
        stream.write(`  "generatedAt": ${JSON.stringify(index.generatedAt)},\n`);
        stream.write(`  "pathCount": ${index.pathCount},\n`);
        stream.write(`  "sourceBucketCount": ${index.sourceBucketCount},\n`);
        stream.write(`  "layerCount": ${index.layerCount},\n`);

        stream.write('  "pathAliases": {\n');
        await writeObjectEntries(stream, pathAliases, '    ');
        stream.write('\n  },\n');

        stream.write('  "sourceBuckets": {\n');
        await writeObjectEntries(stream, compactSourceBuckets, '    ');
        stream.write('\n  },\n');

        stream.write('  "layers": {\n');
        await writeObjectEntries(stream, layers, '    ');
        stream.write('\n  }\n');

        stream.write('}\n');
        stream.end(resolve);
      })().catch(error => {
        stream.destroy(error);
      });
    });

    this._cachedIndex = index;
    this._cachedIndexTime = Date.now();
    return index;
  }

  async readIndex() {
    if (this._cachedIndex && (Date.now() - this._cachedIndexTime < 60000)) {
      return this._cachedIndex;
    }
    if (!(await fs.pathExists(this.indexPath))) return null;
    this._cachedIndex = await fs.readJson(this.indexPath);
    this._cachedIndexTime = Date.now();
    return this._cachedIndex;
  }

  async loadIndex() {
    return this.readIndex();
  }

  async resolveEntry(pathCode, date, iCode) {
    const index = await this.readIndex();
    if (!index) return null;
    const alias = index.pathAliases?.[pathCode];
    if (!alias) return null;
    const bucket = index.sourceBuckets?.[alias.sourcePath];
    if (!bucket || !Array.isArray(bucket.entries)) return null;
    return bucket.entries.find(entry => entry.date === date && Number(entry.iCode) === Number(iCode)) || null;
  }

  async exportGeoJSON(options = {}) {
    await this.init();
    const index = (await this.readIndex()) || (await this.buildIndex());

    const verifiedOnly = !!options.verifiedOnly;
    const mode = options.mode || (verifiedOnly ? 'sources-verified' : 'sources');

    if (mode === 'raw') {
      return this.exportRawGeoJSON({ verifiedOnly, index });
    }
    return this.exportSourceGeoJSON({ verifiedOnly, index });
  }

  async exportSourceGeoJSON({ verifiedOnly, index }) {
    const outName = verifiedOnly ? 'coverage_sources_verified.geojson' : 'coverage_sources.geojson';
    const outPath = path.join(this.exportDir, outName);

    const verifiedPaths = new Set();
    if (verifiedOnly) {
      for await (const verify of this.iterateVerifyRecords()) {
        if (verify.verified) verifiedPaths.add(verify.pathCode);
      }
    }

    const grouped = {};
    for (const alias of Object.values(index.pathAliases || {})) {
      if (verifiedOnly && !verifiedPaths.has(alias.path)) continue;
      const poly = bboxPolygon(alias.bounds);
      if (!poly) continue;
      const sourcePath = alias.sourcePath;
      if (!grouped[sourcePath]) grouped[sourcePath] = [];
      grouped[sourcePath].push(poly.coordinates);
    }

    const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
    stream.write('{"type":"FeatureCollection","features":[\n');

    let first = true;
    let featureCount = 0;
    for (const [sourcePath, polygons] of Object.entries(grouped)) {
      const bucket = index.sourceBuckets?.[sourcePath];
      if (!bucket || !polygons.length) continue;
      const feature = {
        type: 'Feature',
        properties: {
          sourcePath,
          entryCount: ensureArray(bucket.entries).length,
          pathCount: polygons.length,
          dates: ensureArray(bucket.entries).map(e => e.date).filter(Boolean),
          iCodes: ensureArray(bucket.entries).map(e => e.iCode).filter(v => v !== undefined),
        },
        geometry: {
          type: 'MultiPolygon',
          coordinates: polygons,
        },
      };
      if (!first) stream.write(',\n');
      first = false;
      featureCount += 1;
      stream.write(JSON.stringify(feature));
    }

    stream.write('\n]}');
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end();
    });

    return {
      outPath,
      filePath: outPath,
      featureCount,
      mode: verifiedOnly ? 'sources-verified' : 'sources',
    };
  }

  async exportRawGeoJSON({ verifiedOnly, index }) {
    const outName = verifiedOnly ? 'coverage_verified_raw.geojson' : 'coverage_raw.geojson';
    const outPath = path.join(this.exportDir, outName);

    const verifiedKeys = new Set();
    if (verifiedOnly) {
      for await (const verify of this.iterateVerifyRecords()) {
        if (verify.verified) verifiedKeys.add(`${verify.pathCode}|${verify.date}|${verify.iCode}|${verify.fToken}`);
      }
    }

    const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
    stream.write('{"type":"FeatureCollection","features":[\n');

    let first = true;
    let featureCount = 0;
    for (const alias of Object.values(index.pathAliases || {})) {
      const bucket = index.sourceBuckets?.[alias.sourcePath];
      if (!bucket) continue;
      const poly = bboxPolygon(alias.bounds);
      if (!poly) continue;

      for (const entry of ensureArray(bucket.entries)) {
        const key = `${alias.path}|${entry.date}|${entry.iCode}|${entry.fToken}`;
        if (verifiedOnly && !verifiedKeys.has(key)) continue;
        const feature = {
          type: 'Feature',
          properties: {
            path: alias.path,
            requestedPath: alias.requestedPath,
            sourcePath: alias.sourcePath,
            zoom: alias.zoom,
            date: entry.date,
            iCode: entry.iCode,
            fToken: entry.fToken,
            base_url: entry.base_url,
          },
          geometry: poly,
        };
        if (!first) stream.write(',\n');
        first = false;
        featureCount += 1;
        stream.write(JSON.stringify(feature));
      }
    }

    stream.write('\n]}');
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end();
    });

    return {
      outPath,
      filePath: outPath,
      featureCount,
      mode: verifiedOnly ? 'raw-verified' : 'raw',
    };
  }
}

module.exports = CoverageIndexStore;
