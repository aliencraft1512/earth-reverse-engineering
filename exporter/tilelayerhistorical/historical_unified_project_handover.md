# Historical Unified Tile Layer Project — Introduction, Architecture, and Commands

## What this project is

This project is a historical imagery discovery, verification, and visualization system for a flatfile-based satellite imagery service.

In plain words, it tries to answer:

- what historical imagery dates exist in an area?
- which internal version (`iCode`) and token (`fToken`) correspond to each date?
- where does each historical entry spatially apply?
- which entries return real tiles?
- how can those results be used to build a unified historical tile layer and a spatial coverage index?

## What the project does

It has four main jobs:

### 1. Discover historical metadata
The system fetches and parses metadata packets that list historical imagery entries for a map area.

Each entry typically contains:
- `date`
- `iCode`
- `fToken`
- `base_url`
- `sourcePath`

### 2. Learn source-path coverage
A key reverse-engineering insight is that metadata often belongs to a shorter ancestor/source path, not to every exact descendant leaf tile path.

So the system learns:
- which leaf paths belong to which source path
- which entries belong to each source path

### 3. Verify real imagery tiles
The system then tries to fetch actual image tiles for historical entries.

It can try:
- the requested leaf path first
- then the resolved `sourcePath` if the leaf fails

If the tile is fetched and decrypted successfully, it is stored in:
- `tile_cache/`

### 4. Build a coverage index and export GeoJSON
The project stores the discovered and verified results in a structured workspace and can export them as GeoJSON so you can visualize historical coverage on a map.

---

## Architecture

### Metadata layer
These parts handle discovery and parsing of historical metadata.

#### `MetadataManager`
Responsible for:
- initializing metadata handling
- refreshing/using `dbRoot`
- resolving entries for paths
- supporting ancestor/source-path behavior

#### `metadata.js`
Responsible for:
- fetching metadata packets
- decrypting/parsing them
- extracting historical entries

### Coverage/index layer
These parts store normalized results and build reusable spatial indexes.

#### `CoverageIndexStore`
Responsible for:
- storing metadata records
- storing verify records
- building a compact coverage index
- exporting GeoJSON

Modern structure:
- many requested paths
- mapped to fewer real `sourcePath` buckets
- each source bucket stores the deduplicated entry list

### Tile layer / verification layer
These parts fetch and cache real imagery tiles.

#### `TileService`
Responsible for:
- building flatfile tile URLs
- trying requested path and/or source path
- decrypting tiles
- writing JPEGs to `tile_cache`
- later serving unified historical tile layers

### Crawler layer
This is the operational command-line tool.

#### `scripts/coverage-crawler.js`
Responsible for:
- area scanning
- metadata probing
- tile verification
- index building
- GeoJSON export

---

## Folder meaning

### Metadata packet cache
`cache/metadata/`

Stores parsed metadata packet JSON files such as `qp-...json`.

### Workspace metadata records
`workspace/coverage/metadata_records/`

Stores normalized per-path metadata records produced by the crawler.

### Workspace verify records
`workspace/coverage/verified_records/`

Stores per-path/per-entry verification results.

### Tile cache
`tile_cache/`

Stores successfully fetched/decrypted JPEG image tiles.

### Coverage exports
`workspace/coverage/exports/`

Stores GeoJSON exports.

### Logs
`workspace/logs/`

Stores crawl/verify logs.

---

## Commands

### Show how many cells an area contains
```bash
node scripts/coverage-crawler.js area-info --bbox 32.1,34.45,34.95,35.85 --zoom-min 14 --zoom-max 16
```

### Probe metadata only
```bash
node scripts/coverage-crawler.js probe-metadata --bbox 32.1,34.45,34.95,35.85 --zoom-min 14 --zoom-max 16 --force true --verbose true
```

### Verify tiles only
```bash
node scripts/coverage-crawler.js verify-tiles --force true --verbose true
```

### Build index only
```bash
node scripts/coverage-crawler.js build-index
```

### Export all coverage as GeoJSON
```bash
node scripts/coverage-crawler.js export-geojson
```

### Export only verified coverage as GeoJSON
```bash
node scripts/coverage-crawler.js export-geojson --verified-only
```

### Run the full pipeline
```bash
node scripts/coverage-crawler.js full-run --bbox 32.1,34.45,34.95,35.85 --zoom-min 14 --zoom-max 16 --force true --verbose true
```

---

## Best practical workflow

### Safer debug workflow
Instead of always using `full-run`, use:

#### Step 1
```bash
node scripts/coverage-crawler.js probe-metadata --bbox 32.1,34.45,34.95,35.85 --zoom-min 14 --zoom-max 16 --force true --verbose true
```

#### Step 2
```bash
node scripts/coverage-crawler.js verify-tiles --force true --verbose true
```

#### Step 3
```bash
node scripts/coverage-crawler.js export-geojson --verified-only
```

That is easier to reason about than a single giant run.

---

## What the project has now proven

Based on the successful outputs so far, the project has now proven:

- historical metadata entries are real
- sourcePath fallback is real
- the correct tile URL may use the sourcePath rather than the leaf path
- real tiles can be fetched and cached
- the project can build a useful spatial coverage index

---

## Recommended next improvements

### High priority
- add verification throttling / smarter sampling
- distinguish metadata coverage from verified coverage clearly
- keep the compact index format
- keep Windows-safe filenames

### Medium priority
- add a proper unified tile endpoint that resolves:
  - requested path first
  - sourcePath fallback second
- expose verified coverage visually in the test UI

### Later
- add smarter export modes:
  - by source path
  - by date+iCode
  - verified-only dissolved coverage
- add selective verification strategies:
  - newest-first
  - representative tile per source bucket
  - layer-by-layer verification
