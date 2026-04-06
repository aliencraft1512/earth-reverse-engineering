# Historical unified layer test — clean restart package

This package is a **fresh test harness** for historical metadata discovery, strict tile verification, coverage indexing, and unified historical tile serving.

It is designed so you can start again **without keeping the old polluted workspace**.

## What changed in this clean package

- **Strict verification by default**: a tile counts as verified only if the **exact requested path** succeeds.
- **Optional source fallback** is still available for debugging with `--allow-source-fallback true`, but it no longer pretends to be a true leaf-tile success.
- **`verify-tiles` respects `--bbox` and `--geojson`**. It no longer silently verifies the whole old workspace.
- **GeoJSON input currently behaves as bbox extraction**, not true polygon masking.
- **Fresh workspace**: this package ships without old `workspace`, `tile_cache`, or `cache/metadata` data.
- **Windows-safe verify filenames** and compact coverage index are included.
- **`full-run` can now skip phases** with `--skip-probe`, `--skip-verify`, `--skip-index`, and `--skip-export`.

## Folder meaning

- `lib/` — core logic
- `scripts/coverage-crawler.js` — crawler CLI
- `scripts/smoke-test.js` — tiny regression smoke test for the local server + UI shell
- `public/` — small browser UI
- `server.js` — local API / test server
- `dbRoot.v5` — metadata dbRoot copy
- `old_dbroot.v5` — tile decryption key source
- `cache/metadata/` — parsed metadata packet cache (created at runtime)
- `workspace/coverage/` — crawler metadata records, verify records, index, exports
- `workspace/logs/` — run logs
- `tile_cache/` — successful JPEG tile cache

## First-time setup

```bash
npm install
```

## Clean restart on Windows

Double-click:

```text
RESET_WORKSPACE.bat
```

That removes only runtime state:
- `workspace/`
- `tile_cache/`
- `cache/metadata/`

It keeps the source code and both `dbRoot` files.

## Recommended test flow

### 1) Start from a small inland Nicosia bbox

```bash
node scripts/coverage-crawler.js probe-metadata --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
```

### 2) Strict verification for the same area

```bash
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
```

### 3) Debug fallback mode only if needed

```bash
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true --allow-source-fallback true
```

### 4) Export only exact verified coverage

```bash
node scripts/coverage-crawler.js export-geojson --verified-only
```

## Full run for the same area

```bash
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
```

## Resumable full-run examples

Skip probe and continue with verification, index, and export:

```bash
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true --skip-probe
```

Skip both probe and verify and only rebuild derived artifacts:

```bash
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --verbose true --skip-probe --skip-verify
```

## Start the test server

```bash
npm start
```

Then open:

```text
http://localhost:3010
```

## Smoke test the local server and UI shell

```bash
npm run smoke
```

This smoke test:
- starts the local server
- checks `/api/health`
- checks `/api/coverage/index`
- checks `/api/coverage/geojson?verifiedOnly=true`
- loads `/` and confirms the timeline UI shell is present
- calls `/api/layers/discover` with a small sample bbox and confirms the JSON shape

## Important interpretation rules

- `probe-metadata` success means the metadata bucket was found.
- `verify-tiles` success with `exactPathMatch: true` means the requested path really worked.
- `verify-tiles` success with `exactPathMatch: false` means only a broader fallback candidate worked. That is **debug evidence**, not true leaf verification.
- `tile_cache/` should only fill when image fetch + decrypt succeeds.
- `--geojson` currently extracts a bbox from the file and processes that rectangle. It does **not** yet clip the run to the polygon geometry itself.

## Useful commands

```bash
node scripts/coverage-crawler.js probe-metadata --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true --allow-source-fallback true
node scripts/coverage-crawler.js build-index
node scripts/coverage-crawler.js export-geojson
node scripts/coverage-crawler.js export-geojson --verified-only
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true --skip-probe
node scripts/coverage-crawler.js full-run --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --verbose true --skip-probe --skip-verify
npm run smoke
```
