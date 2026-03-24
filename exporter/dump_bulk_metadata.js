#!/usr/bin/env node
"use strict";

const fs = require("fs-extra");
const path = require("path");

const initUtils = require("./lib/utils");
const initConvertLatLongToOctant = require("./lib/convert-lat-long-to-octant");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;

    const key = a.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function num(v, fallback = null) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeName(p) {
  return !p ? "root" : p.replace(/[^\w.-]/g, "_");
}

function decodeFlags(flags) {
  const out = [];
  if (flags & 1) out.push("RICH3D_LEAF");
  if (flags & 2) out.push("RICH3D_NODATA");
  if (flags & 4) out.push("LEAF");
  if (flags & 8) out.push("NODATA");
  if (flags & 16) out.push("USE_IMAGERY_EPOCH");
  return out;
}

async function writeJson(file, data) {
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, data, { spaces: 2 });
}

function summarizeBulk(utils, bulk, bulkPath) {
  const relPaths = utils.bulk.allPaths(bulk);
  const entries = [];

  for (const relPath of relPaths) {
    const index = utils.bulk.getIndexByPath(bulk, relPath);
    if (index < 0) continue;

    const absolutePath = `${bulkPath}${relPath}`;
    const flags = bulk.flags?.[index] ?? null;

    entries.push({
      index,
      bulkPath,
      relativePath: relPath,
      absolutePath,

      flags,
      flagNames: flags === null ? [] : decodeFlags(flags),

      hasNode:
        flags === null ? null : utils.bulk.hasNodeAtIndex(bulk, index),
      hasBulkMetadata:
        flags === null ? null : utils.bulk.hasBulkMetadataAtIndex(bulk, index),

      epoch: bulk.epoch?.[index] ?? null,
      bulkMetadataEpoch: bulk.bulkMetadataEpoch?.[index] ?? null,

      imageryEpoch:
        bulk.imageryEpochArray?.[index] ??
        bulk.defaultImageryEpoch ??
        null,

      textureFormat:
        bulk.textureFormatArray?.[index] ??
        bulk.defaultTextureFormat ??
        null,

      metersPerTexel:
        bulk.metersPerTexel?.[index] ?? null,

      orientedBoundingBox:
        bulk.orientedBoundingBox?.[index] ?? null,

      processingOrientedBoundingBox:
        bulk.processingOrientedBoundingBox?.[index] ?? null,
    });
  }

  return {
    bulkPath,
    entryCount: entries.length,
    defaultImageryEpoch: bulk.defaultImageryEpoch ?? null,
    defaultTextureFormat: bulk.defaultTextureFormat ?? null,
    entries,
  };
}

async function traceNodePath(utils, nodePath, outDir, fetchNode = false) {
  const planetoid = await utils.getPlanetoid();
  const rootEpoch = planetoid.bulkMetadataEpoch[0];

  const trace = {
    nodePath,
    rootEpoch,
    steps: [],
    final: null,
  };

  let bulk = null;
  let index = -1;
  let epoch = rootEpoch;

  for (let i = 4; i < nodePath.length + 4; i += 4) {
    const bulkPath = nodePath.substring(0, i - 4);
    const subPath = nodePath.substring(0, i);

    if (bulk) {
      const idxForBulkPath = utils.bulk.getIndexByPath(bulk, bulkPath);
      const previousHasBulk =
        idxForBulkPath >= 0
          ? utils.bulk.hasBulkMetadataAtIndex(bulk, idxForBulkPath)
          : null;

      trace.steps.push({
        type: "precheck",
        bulkPath,
        subPath,
        epoch,
        idxForBulkPath,
        previousHasBulkMetadata: previousHasBulk,
      });

      if (previousHasBulk) {
        trace.final = {
          exists: false,
          reason: "Encountered nested bulk metadata boundary before terminal node",
        };
        await writeJson(
          path.join(outDir, "traces", `${safeName(nodePath)}.trace.json`),
          trace
        );
        return trace;
      }
    }

    bulk = await utils.getBulk(bulkPath, epoch);
    index = utils.bulk.getIndexByPath(bulk, subPath);

    if (index < 0) {
      trace.steps.push({
        type: "bulk",
        bulkPath,
        subPath,
        epoch,
        index,
        found: false,
      });

      trace.final = {
        exists: false,
        reason: "Path not found in bulk metadata",
      };

      await writeJson(
        path.join(outDir, "traces", `${safeName(nodePath)}.trace.json`),
        trace
      );
      return trace;
    }

    const flags = bulk.flags?.[index] ?? null;

    trace.steps.push({
      type: "bulk",
      bulkPath,
      subPath,
      epoch,
      index,
      found: true,
      flags,
      flagNames: flags === null ? [] : decodeFlags(flags),
      hasNode: utils.bulk.hasNodeAtIndex(bulk, index),
      hasBulkMetadata: utils.bulk.hasBulkMetadataAtIndex(bulk, index),
      epochAtIndex: bulk.epoch?.[index] ?? null,
      bulkMetadataEpochAtIndex: bulk.bulkMetadataEpoch?.[index] ?? null,
      imageryEpochAtIndex:
        bulk.imageryEpochArray?.[index] ??
        bulk.defaultImageryEpoch ??
        null,
      textureFormatAtIndex:
        bulk.textureFormatArray?.[index] ??
        bulk.defaultTextureFormat ??
        null,
      metersPerTexelAtIndex: bulk.metersPerTexel?.[index] ?? null,
      orientedBoundingBoxAtIndex: bulk.orientedBoundingBox?.[index] ?? null,
      processingOrientedBoundingBoxAtIndex:
        bulk.processingOrientedBoundingBox?.[index] ?? null,
    });

    epoch = bulk.bulkMetadataEpoch[index];
  }

  if (index < 0 || !utils.bulk.hasNodeAtIndex(bulk, index)) {
    trace.final = {
      exists: false,
      reason: "Terminal path resolved but has no node payload",
    };
  } else {
    trace.final = {
      exists: true,
      nodeIndex: index,
      nodeEpoch: bulk.epoch?.[index] ?? null,
      imageryEpoch:
        bulk.imageryEpochArray?.[index] ??
        bulk.defaultImageryEpoch ??
        null,
      textureFormat:
        bulk.textureFormatArray?.[index] ??
        bulk.defaultTextureFormat ??
        null,
    };

    if (fetchNode) {
      const node = await utils.getNode(nodePath, bulk, index);
      await writeJson(
        path.join(outDir, "nodes", `${safeName(nodePath)}.node.json`),
        node
      );
    }
  }

  await writeJson(
    path.join(outDir, "traces", `${safeName(nodePath)}.trace.json`),
    trace
  );
  return trace;
}

async function crawlBulkTree(utils, outDir, maxBulkDepth) {
  const planetoid = await utils.getPlanetoid();
  await writeJson(path.join(outDir, "planetoid.json"), planetoid);

  const rootEpoch = planetoid.bulkMetadataEpoch[0];
  const visited = new Set();
  const index = [];

  async function recurse(bulkPath, epoch, depth) {
    const visitKey = `${bulkPath}@${epoch}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const bulk = await utils.getBulk(bulkPath, epoch);
    const summary = summarizeBulk(utils, bulk, bulkPath);

    await writeJson(
      path.join(outDir, "bulks", `${safeName(bulkPath)}.raw.json`),
      bulk
    );
    await writeJson(
      path.join(outDir, "bulks", `${safeName(bulkPath)}.summary.json`),
      summary
    );

    index.push({
      bulkPath,
      epoch,
      depth,
      entryCount: summary.entryCount,
      fileBase: safeName(bulkPath),
    });

    if (depth >= maxBulkDepth) return;

    for (const entry of summary.entries) {
      if (entry.hasBulkMetadata && entry.bulkMetadataEpoch !== null) {
        await recurse(entry.absolutePath, entry.bulkMetadataEpoch, depth + 1);
      }
    }
  }

  await recurse("", rootEpoch, 0);

  await writeJson(path.join(outDir, "bulk_index.json"), {
    rootEpoch,
    maxBulkDepth,
    bulkCount: index.length,
    bulks: index,
  });
}

async function dumpLocationMetadata(
  utils,
  convertLatLongToOctant,
  outDir,
  lat,
  lon,
  maxLevel,
  fetchNode
) {
  const foundOctants = await convertLatLongToOctant(lat, lon, maxLevel);

  await writeJson(path.join(outDir, "location_octants.json"), {
    lat,
    lon,
    maxLevel,
    foundOctants,
  });

  const seen = new Set();

  for (const level of Object.keys(foundOctants).sort((a, b) => Number(a) - Number(b))) {
    for (const octant of foundOctants[level].octants) {
      if (seen.has(octant)) continue;
      seen.add(octant);
      await traceNodePath(utils, octant, outDir, fetchNode);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const outDir = path.resolve(
    args.out || path.join(__dirname, "downloaded_files", "metadata_dump")
  );

  const maxBulkDepth = num(args["max-bulk-depth"], 1);
  const maxLevel = num(args["max-level"], 12);
  const lat = num(args.lat, null);
  const lon = num(args.lon, null);
  const fetchNode = !!args["fetch-node"];

  const utils = initUtils({
    URL_PREFIX: "https://kh.google.com/rt/earth/",
    DUMP_JSON_DIR: path.join(outDir, "_repo_json_cache"),
    DUMP_RAW_DIR: path.join(outDir, "_repo_raw_cache"),
    DUMP_JSON: false,
    DUMP_RAW: false,
  });

  const convertLatLongToOctant = initConvertLatLongToOctant(utils);

  await fs.ensureDir(outDir);

  console.log(`Output directory: ${outDir}`);

  // 1) Always dump the planetoid + bulk tree up to a safe depth
  console.log(`Crawling bulk metadata tree up to bulk depth ${maxBulkDepth}...`);
  await crawlBulkTree(utils, outDir, maxBulkDepth);

  // 2) Optional: targeted location dump
  if (lat !== null && lon !== null) {
    console.log(`Finding octants for lat=${lat}, lon=${lon}, maxLevel=${maxLevel}...`);
    await dumpLocationMetadata(
      utils,
      convertLatLongToOctant,
      outDir,
      lat,
      lon,
      maxLevel,
      fetchNode
    );
  }

  console.log("Done.");
  console.log("Files written:");
  console.log(`- ${path.join(outDir, "planetoid.json")}`);
  console.log(`- ${path.join(outDir, "bulk_index.json")}`);
  console.log(`- ${path.join(outDir, "bulks", "*.raw.json")}`);
  console.log(`- ${path.join(outDir, "bulks", "*.summary.json")}`);
  if (lat !== null && lon !== null) {
    console.log(`- ${path.join(outDir, "location_octants.json")}`);
    console.log(`- ${path.join(outDir, "traces", "*.trace.json")}`);
    if (fetchNode) {
      console.log(`- ${path.join(outDir, "nodes", "*.node.json")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
