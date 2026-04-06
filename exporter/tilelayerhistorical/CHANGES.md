# Changes made

## Main fixes

1. **`verify-tiles` now respects `--bbox` / `--geojson`**
   - Before: it scanned every path already in the workspace, so a Nicosia test still verified the whole Cyprus workspace.
   - After: it can be limited to the requested area.

2. **Strict tile verification is now the default**
   - Before: a successful `sourcePath` image was treated like a true success for the requested leaf path.
   - After: `verify-tiles` only counts exact requested-path success as `verified: true` by default.
   - Optional source-bucket fallback is still available with `--allow-source-fallback true`, but it is recorded separately as `sourceBucketVerified`.

3. **Unified tile endpoint is strict by default**
   - `/tiles/unified/...` now uses exact-path matching by default.
   - Optional debug fallback can be enabled with `?allowSourceFallback=true`.

## Important commands

### Probe metadata for Nicosia-ish area
```bash
node scripts/coverage-crawler.js probe-metadata --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
```

### Verify tiles only for that area (strict)
```bash
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --force true --verbose true
```

### Verify tiles with source fallback allowed (debug only)
```bash
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --force true --verbose true --allow-source-fallback true
```
