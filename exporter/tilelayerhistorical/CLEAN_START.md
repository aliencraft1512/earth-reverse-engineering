# Clean start checklist

1. Unzip this project into a **new folder**.
2. Open a terminal in that folder.
3. Run:

```bash
npm install
```

4. If you ever want to erase only runtime state, run:

```text
RESET_WORKSPACE.bat
```

5. Start with this small inland test:

```bash
node scripts/coverage-crawler.js probe-metadata --bbox 33.28,35.10,33.45,35.22 --zoom-min 16 --zoom-max 16 --force true --verbose true
node scripts/coverage-crawler.js verify-tiles --bbox 33.28,35.10,33.45,35.22 --force true --verbose true
```

6. Check:
- `workspace/logs/`
- `workspace/coverage/verified_records/`
- `tile_cache/`

7. Only after that, try a wider bbox.
