const express = require('express');
const path = require('path');
const cors = require('cors');

const MetadataManager = require('./lib/MetadataManager');
const CoverageIndexStore = require('./lib/CoverageIndexStore');
const TileService = require('./lib/TileService');

const app = express();
const PORT = process.env.PORT || 3010;
const ROOT = __dirname;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));

const manager = new MetadataManager(ROOT);
const coverage = new CoverageIndexStore(ROOT);
const tileService = new TileService(ROOT, { manager, coverageIndex: coverage });

app.use('/tile_cache', express.static(path.join(ROOT, 'tile_cache'), {
  maxAge: '30d',
  immutable: false,
}));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', async (req, res) => {
  const index = await coverage.readIndex().catch(() => null);
  res.json({
    ok: true,
    now: new Date().toISOString(),
    node: process.version,
    hasMetadataKey: Boolean(manager.metadataKey),
    hasTileKey: Boolean(tileService.secretKey),
    coverageIndex: index ? {
      pathCount: index.pathCount,
      layerCount: index.layerCount,
      generatedAt: index.generatedAt,
    } : null,
  });
});

app.post('/api/refresh-dbroot', async (req, res) => {
  try {
    const metadataOk = await manager.refreshDbRoot();
    tileService.loadOldSecretKey();
    res.json({ ok: metadataOk });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/catalog/bounds', async (req, res) => {
  try {
    const { bounds, zoom } = req.body || {};
    if (!bounds || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'Missing bounds/zoom' });
    }
    const summary = await manager.buildBoundsCatalog(bounds, zoom);
    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/layers/discover', async (req, res) => {
  try {
    const { bounds, zoom } = req.body || {};
    if (!bounds || typeof zoom !== 'number') {
      return res.status(400).json({ error: 'Missing bounds/zoom' });
    }
    const result = await manager.discoverLogicalLayers(bounds, zoom);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/coverage/index', async (req, res) => {
  try {
    const index = await coverage.readIndex() || await coverage.buildIndex();
    return res.json(index);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/coverage/geojson', async (req, res) => {
  try {
    const verifiedOnly = ['1', 'true', 'yes'].includes(String(req.query.verifiedOnly || '').toLowerCase());
    const exported = await coverage.exportGeoJSON({ verifiedOnly });
    return res.json({
      ok: true,
      filePath: exported.filePath || exported.outPath,
      outPath: exported.outPath || exported.filePath,
      featureCount: Number.isFinite(exported.featureCount) ? exported.featureCount : null,
      mode: exported.mode || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/tiles/unified/:date/:iCode/:z/:x/:y.:ext?', async (req, res) => {
  try {
    const { date, iCode, z, x, y } = req.params;
    const allowSourceFallback = ['1', 'true', 'yes'].includes(String(req.query.allowSourceFallback || '').toLowerCase());
    const result = await tileService.getUnifiedTile({
      date,
      iCode: Number(iCode),
      z: Number(z),
      x: Number(x),
      y: Number(y),
      allowSourceFallback,
    });
    res.status(result.status || 200);
    res.setHeader('Content-Type', result.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(result.buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/resolve/:date/:iCode/:z/:x/:y', async (req, res) => {
  try {
    const { date, iCode, z, x, y } = req.params;
    const allowSourceFallback = ['1', 'true', 'yes'].includes(String(req.query.allowSourceFallback || '').toLowerCase());
    const result = await tileService.getUnifiedTile({
      date,
      iCode: Number(iCode),
      z: Number(z),
      x: Number(x),
      y: Number(y),
      allowSourceFallback,
    });
    return res.json({
      ok: result.ok,
      status: result.status,
      pathCode: result.pathCode,
      resolvedPathCode: result.resolvedPathCode || null,
      exactPathMatch: result.exactPathMatch || false,
      candidateType: result.candidateType || null,
      entry: result.entry || null,
      tileUrl: result.tileUrl || null,
      reason: result.reason || null,
      attempts: result.attempts || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

async function start() {
  await manager.init();
  await tileService.init();
  app.listen(PORT, () => {
    console.log(`Historical unified test server running at http://localhost:${PORT}`);
  });
}

start().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
