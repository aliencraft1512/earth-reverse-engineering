

const fs = require('fs-extra');
const path = require('path');
const CoverageIndexStore = require('../lib/CoverageIndexStore');
const MetadataManager = require('../lib/MetadataManager');
const TileService = require('../lib/TileService');
const { buildPathCellsForBounds } = require('../lib/pathUtils');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function toNumber(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBBox(text) {
  const parts = String(text).split(',').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
    throw new Error('Invalid --bbox. Expected west,south,east,north');
  }
  const [west, south, east, north] = parts;
  return { west, south, east, north };
}

function extractNumbersDeep(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) extractNumbersDeep(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) extractNumbersDeep(item, out);
    return out;
  }
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  return out;
}

function bboxFromGeoJSON(geojson) {
  const nums = extractNumbersDeep(geojson, []);
  if (nums.length < 4 || nums.length % 2 !== 0) {
    throw new Error('Unable to derive bbox from GeoJSON');
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    const lon = nums[i];
    const lat = nums[i + 1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error('Unable to derive bbox from GeoJSON');
  }
  return { west, south, east, north };
}

async function loadAreaTiles(args) {
  const zoomMin = toNumber(args['zoom-min'], 14);
  const zoomMax = toNumber(args['zoom-max'], 16);

  let bounds;
  if (args.bbox) {
    bounds = parseBBox(args.bbox);
  } else if (args.geojson) {
    const geojson = await fs.readJson(path.resolve(args.geojson));
    bounds = bboxFromGeoJSON(geojson);
  } else {
    throw new Error('Provide --bbox or --geojson');
  }

  const all = [];
  for (let z = zoomMin; z <= zoomMax; z += 1) {
    const cells = buildPathCellsForBounds(bounds, z).map(cell => ({ ...cell, z }));
    for (const cell of cells) {
      all.push(cell);
    }
  }
  return all;
}

function createLogger(logPath, verbose = false) {
  fs.ensureDirSync(path.dirname(logPath));
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  function write(level, message, extra) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
    stream.write(`${line}\n`);
    if (verbose || level !== 'DEBUG') console.log(line);
  }

  return {
    debug: (m, e) => write('DEBUG', m, e),
    info: (m, e) => write('INFO', m, e),
    error: (m, e) => write('ERROR', m, e),
    close: () => new Promise(resolve => stream.end(resolve)),
    path: logPath,
  };
}

function skippedPhase(name, reason) {
  return {
    status: 'skipped',
    phase: name,
    reason,
  };
}

async function cmdBuildIndex(context) {
  const { store, logger } = context;
  const index = await store.buildIndex();
  const result = {
    status: 'ok',
    pathCount: index.pathCount,
    sourceBucketCount: index.sourceBucketCount,
    layerCount: index.layerCount,
    indexPath: store.indexPath,
    logPath: logger.path,
  };
  logger.info('build-index finished', result);
  return result;
}

async function cmdExportGeoJSON(context, args) {
  const { store, logger } = context;
  const mode = args.mode || undefined;
  const verifiedOnly = toBool(args['verified-only'], false);
  const result = await store.exportGeoJSON({ verifiedOnly, mode });
  logger.info('export-geojson finished', { ...result, logPath: logger.path });
  return result;
}

async function cmdProbeMetadata(context, args) {
  const { store, metadataManager, logger } = context;
  const cells = await loadAreaTiles(args);
  const force = toBool(args.force, false);
  const knownSources = new Map();

  let cellsVisited = 0;
  let networkFetches = 0;
  let sourceReuseHits = 0;
  let skippedExisting = 0;
  let metadataHits = 0;
  let zeroEntryCells = 0;
  let fallbackHits = 0;
  let errors = 0;

  const index = await store.readIndex();
  if (index && index.sourceBuckets) {
    for (const bucket of Object.values(index.sourceBuckets)) {
      if (Array.isArray(bucket.entries) && bucket.entries.length) {
        knownSources.set(bucket.sourcePath, bucket.entries);
      }
    }
  }

  logger.info('probe-metadata started', { totalCells: cells.length, force, logPath: logger.path });

  for (const cell of cells) {
    cellsVisited += 1;
    if (cellsVisited % 100 === 0) {
      logger.info('probe-metadata progress', {
        totalCells: cells.length,
        cellsVisited,
        networkFetches,
        sourceReuseHits,
        skippedExisting,
        metadataHits,
        zeroEntryCells,
        fallbackHits,
        errors,
        knownSourceCount: knownSources.size,
      });
    }

    const fileTarget = path.join(store.metadataDir, String(cell.z), `${cell.path}.json`);
    const alreadyDone = !force && await fs.pathExists(fileTarget);
    if (alreadyDone) {
      skippedExisting += 1;
      continue;
    }

    let aliasSource = null;
    for (let len = cell.path.length; len >= 4; len -= 1) {
      const candidate = cell.path.slice(0, len);
      if (knownSources.has(candidate)) {
        aliasSource = candidate;
        break;
      }
    }
    if (aliasSource) {
      const aliasEntries = knownSources.get(aliasSource) || [];
      const record = {
        zoom: cell.z,
        path: cell.path,
        requestedPath: cell.path,
        sourcePath: aliasSource,
        fallback: aliasSource !== cell.path,
        bounds: cell.bounds,
        entries: aliasEntries,
      };
      await store.writeMetadataRecord(cell.z, cell.path, record);
      metadataHits += 1;
      sourceReuseHits += 1;
      if (record.fallback) fallbackHits += 1;
      logger.debug('probe-metadata alias from known source', {
        zoom: cell.z,
        path: cell.path,
        sourcePath: aliasSource,
        entryCount: aliasEntries.length,
        firstEntries: aliasEntries.slice(0, 3).map(e => ({ date: e.date, iCode: e.iCode, fToken: e.fToken })),
      });
    } else {
      try {
        const result = await metadataManager.fetchMetadata(cell.path);
        networkFetches += 1;
        const entries = Array.isArray(result?.entries) ? result.entries : [];
        const sourcePath = result?.sourcePath || cell.path;
        const record = {
          zoom: cell.z,
          path: cell.path,
          requestedPath: cell.path,
          sourcePath,
          fallback: sourcePath !== cell.path,
          bounds: cell.bounds,
          entries,
        };
        await store.writeMetadataRecord(cell.z, cell.path, record);
        if (entries.length) {
          knownSources.set(sourcePath, entries);
          metadataHits += 1;
          if (record.fallback) fallbackHits += 1;
        } else {
          zeroEntryCells += 1;
        }
        logger.debug('probe-metadata result', {
          zoom: cell.z,
          path: cell.path,
          sourcePath,
          fallback: record.fallback,
          entryCount: entries.length,
          firstEntries: entries.slice(0, 3).map(e => ({ date: e.date, iCode: e.iCode, fToken: e.fToken })),
        });
      } catch (error) {
        errors += 1;
        logger.error('probe-metadata failed', { zoom: cell.z, path: cell.path, error: error.message });
      }
    }

  }

  const finalIndex = await store.buildIndex();
  const result = {
    status: 'ok',
    totalCells: cells.length,
    cellsVisited,
    networkFetches,
    sourceReuseHits,
    skippedExisting,
    metadataHits,
    zeroEntryCells,
    fallbackHits,
    errors,
    knownSourceCount: knownSources.size,
    pathCount: finalIndex.pathCount,
    layerCount: finalIndex.layerCount,
    logPath: logger.path,
  };
  logger.info('probe-metadata finished', result);
  return result;
}

async function cmdVerifyTiles(context, args) {
  const { store, tileService, logger } = context;
  const force = toBool(args.force, false);
  const allowSourceFallback = toBool(args['allow-source-fallback'], false);
  const filterCells = await loadAreaTiles(args);

  let totalPaths = 0;
  let totalEntries = 0;
  let attempted = 0;
  let skippedExisting = 0;
  let verifiedOk = 0;
  let verifiedFailed = 0;
  let sourceFallbackOnly = 0;
  let cacheHits = 0;
  let cacheWrites = 0;

  logger.info('verify-tiles started', {
    totalPaths: filterCells.length,
    force,
    allowSourceFallback,
    area: args.bbox ? { mode: 'bbox', bbox: parseBBox(args.bbox), polygons: [] } : { mode: 'geojson', geojson: args.geojson },
    logPath: logger.path,
  });

  for (const cell of filterCells) {
    const record = await store.readMetadataRecord(cell.z, cell.path);
    if (!record) continue;
    totalPaths += 1;
    const entries = Array.isArray(record.entries) ? record.entries : [];
    logger.debug('verify-tiles path batch', { pathCode: record.path, entryCount: entries.length });

    for (const entry of entries) {
      totalEntries += 1;
      const existing = await store.readVerifyRecord(record.path, entry);
      const isFailedRecord = existing && existing.verified === false;
      if (existing && !force && !isFailedRecord) {
        skippedExisting += 1;
        continue;
      }

      attempted += 1;
      try {
        const result = await tileService.fetchAndCacheTileForEntry(record.path, entry, { allowSourceFallback });
        const verify = {
          pathCode: record.path,
          requestedPathCode: result.requestedPathCode,
          resolvedPathCode: result.usedPathCode,
          exactPathMatch: !!result.exactPathMatch,
          candidateType: result.candidateType,
          date: entry.date,
          iCode: entry.iCode,
          fToken: entry.fToken,
          sourcePath: entry.sourcePath || record.sourcePath,
          tileUrl: result.tileUrl,
          cachePath: result.cachePath,
          fromCache: result.fromCache,
          attempts: result.attempts || [],
          verified: !!result.exactPathMatch,
          sourceBucketVerified: !result.exactPathMatch,
          verifiedAt: new Date().toISOString(),
        };
        await store.writeVerifyRecord(record.path, entry, verify);
        verifiedOk += 1;
        if (!verify.exactPathMatch) sourceFallbackOnly += 1;
        if (verify.fromCache) cacheHits += 1;
        else cacheWrites += 1;
        logger.debug('verify-tiles success', verify);
      } catch (error) {
        const failure = {
          pathCode: record.path,
          date: entry.date,
          iCode: entry.iCode,
          fToken: entry.fToken,
          sourcePath: entry.sourcePath || record.sourcePath,
          tileUrl: error.tileUrl || null,
          statusCode: error.status || error.statusCode || null,
          error: error.message,
          attempts: error.attempts || [],
          verified: false,
          sourceBucketVerified: false,
        };
        await store.writeVerifyRecord(record.path, entry, failure);
        verifiedFailed += 1;
        logger.error('verify-tiles failed', failure);
      }

      if (attempted % 50 === 0) {
        logger.info('verify-tiles progress', {
          totalPaths,
          totalEntries,
          attempted,
          skippedExisting,
          verifiedOk,
          verifiedFailed,
          sourceFallbackOnly,
          cacheHits,
          cacheWrites,
        });
      }
    }
  }

  const result = {
    status: 'ok',
    totalPaths,
    totalEntries,
    attempted,
    skippedExisting,
    verifiedOk,
    verifiedFailed,
    sourceFallbackOnly,
    cacheHits,
    cacheWrites,
    logPath: logger.path,
  };
  logger.info('verify-tiles finished', result);
  return result;
}

async function cmdFullRun(context, args) {
  const skipProbe = toBool(args['skip-probe'], false);
  const skipVerify = toBool(args['skip-verify'], false);
  const skipIndex = toBool(args['skip-index'], false);
  const skipExport = toBool(args['skip-export'], false);

  const probe = skipProbe
    ? skippedPhase('probe-metadata', '--skip-probe')
    : await cmdProbeMetadata(context, args);

  const verify = skipVerify
    ? skippedPhase('verify-tiles', '--skip-verify')
    : await cmdVerifyTiles(context, args);

  const index = skipIndex
    ? skippedPhase('build-index', '--skip-index')
    : await cmdBuildIndex(context, args);

  const exported = skipExport
    ? skippedPhase('export-geojson', '--skip-export')
    : await cmdExportGeoJSON(context, args);

  return { probe, verify, index, exported };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const rootDir = path.join(process.cwd(), 'workspace', 'coverage');
  const logsDir = path.join(process.cwd(), 'workspace', 'logs');
  const logPath = path.join(logsDir, `crawler-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const logger = createLogger(logPath, toBool(args.verbose, false));

  const store = new CoverageIndexStore({ rootDir });
  await store.init();

  let metadataManager = null;
  let tileService = null;
  const needsLiveServices = ['probe-metadata', 'verify-tiles', 'full-run'].includes(command);

  if (needsLiveServices) {
    metadataManager = new MetadataManager(process.cwd());
    await metadataManager.init();
    tileService = new TileService(process.cwd(), { manager: metadataManager, coverageIndex: store });
    await tileService.init();
  }

  const context = { store, metadataManager, tileService, logger };

  try {
    let result;
    switch (command) {
      case 'probe-metadata':
        result = await cmdProbeMetadata(context, args);
        break;
      case 'verify-tiles':
        result = await cmdVerifyTiles(context, args);
        break;
      case 'build-index':
        result = await cmdBuildIndex(context, args);
        break;
      case 'export-geojson':
        result = await cmdExportGeoJSON(context, args);
        break;
      case 'full-run':
        result = await cmdFullRun(context, args);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.error('fatal', { error: error.message, stack: error.stack });
    console.error(error);
    process.exitCode = 1;
  } finally {
    await logger.close();
  }
}

main();