#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf workspace tile_cache cache/metadata
mkdir -p workspace/coverage workspace/logs tile_cache cache/metadata
printf 'Done. The source code and dbRoot files were kept.\n'
