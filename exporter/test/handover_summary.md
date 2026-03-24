handover_summary.md# Handover summary: historical flatfile reverse-engineering + bbox chronology reconstruction

## User goal
The goal is to reconstruct all valid historical chronologies for a bounding box and, for each chronology/date, construct valid URLs of the form:

`f1-{path}-i.{iCode}-{fToken}`

where all parts are valid for the same location/branch.

## What was investigated

### 1) Earth reverse-engineering repo
The repo centered on three resource families:
- `PlanetoidMetadata`
- `BulkMetadata`
- `NodeData`

What was confirmed from the repo and from the user’s dumps:
- Earth-side resources are organized in an octree.
- `PlanetoidMetadata` gives the first bulk epoch.
- `BulkMetadata` gives `flags`, `epoch`, `bulkMetadataEpoch`, `imageryEpoch`, `textureFormat`, `metersPerTexel`, etc.
- `NodeData` contains actual mesh/texture data.
- `decodeFlags(flags)` is useful for understanding Earth-side node/bulk semantics, but not enough to decode the historical `tm` flatfile `i.xxx` logic.

### 2) Earth-side probes performed
For locations like Troodos and Nicosia, deep Earth octant traces were collected.
Key conclusions:
- Earth-side octants resolve to paths like `304361...`, not the CMP historical `0200...` style path family.
- Earth-side metadata exposes versioning such as `nodeEpoch` and `imageryEpoch` (e.g. `1005`, `1030`, `1032`, and in one deep branch `1001`, `1025`).
- These Earth-side epochs do **not** look like a direct one-to-one mapping to the CMP historical `i.xxx` values.

### 3) Historical flatfile chronology work
The chronology token was isolated as the `fXXXX` part.
The user already had evidence that the hex token can be decoded as chronology/date-oriented and supplied large historical lists.

Main conclusion:
- `fXXXX` is the chronology selector.
- `i.xxx` is not the date itself.

### 4) Controlled flatfile validity experiments
A crucial set of experiments was run on `https://khmdb.google.com/flatfile?db=tm...`, keeping one variable fixed at a time.

#### Results
- Same path + same `i`, changing only `f` returns different successful binaries.
  - Therefore `fToken` controls chronology/content.
- Same path + same `f`, changing only `i` can flip a request from `200 OK` to `404 Not Found`.
  - Therefore `i.xxx` is a real selector.
- Same `f` + same `i`, sibling paths can still differ and can require different valid `i` values.
  - Therefore path matters too.

### 5) Final validity rule proven experimentally
A valid historical result depends on the triple:

`(path, fToken, iCode)`

This is the single most important conclusion from the conversation.

## What was learned about `i.xxx`

### What it is not
- not the chronology token
- not a simple global increasing version counter
- not something directly exposed by Earth `imageryEpoch`

### What it likely is
A path-aware imagery/version selector that must be valid for that exact path and chronology.

## Why runtime probing caused problems
The first runtime server rewrite tried to discover valid `i` codes on the fly while the map was moving and slider events were firing.
This caused severe latency / spinner problems because the search space is too large to compute live on every request.

## Important correction made
Earlier, the Earth node JSONs appeared to contain year->code tables. After reviewing the raw structure more carefully, that was not reliable enough to treat as a decoded historical version catalog. The large numeric structures in node JSONs are primarily mesh / texture / BVH / geometry data.

So the honest conclusion is:
- Earth reverse-engineered JSON is useful for Earth-side structure and epochs.
- It is **not enough by itself** to directly enumerate all historical `i.xxx` values for a bbox.

## Metadata bootstrap files collected from the tm historical side
Two important files were collected:
- `D1_qp_q366.bin` (`qp-...-q.366`) — 4021 bytes, `200 OK`
- `D2_dbRoot_v5_tm.proto` (`dbRoot.v5?...output=proto`) — 7955 bytes, `200 OK`

### What was found in `dbRoot.v5`
A simple protobuf parse showed:
- field 1 = varint `0`
- field 2 = length-delimited blob of `1016` bytes
- field 3 = length-delimited blob of `6931` bytes

This is meaningful because the user’s prior XOR/decrypt routine for tm flatfiles wraps at `1016`, strongly suggesting field 2 is key/schedule/bootstrap material.

### What was found in `qp-...-q.366`
It did not decode directly as plain protobuf or plain compressed data. It appears to be opaque/packed/encrypted metadata rather than a ready plain-text catalog.

## Why decryption was not already “solved”
It is not because nothing was attempted. It is because:
- the exact tm schema/parser is still unknown,
- `dbRoot.v5` clearly contains structured bootstrap material,
- but `qp-...-q.xxx` does not simply decode as direct protobuf/json with the currently known transform.

So the current honest state is:
- there is meaningful metadata there,
- but the exact tm catalog format is not yet fully decoded.

## Correct architecture going forward

### Runtime approach is too slow
Do **not** calculate valid `(path, fToken, iCode)` combinations live during pan/zoom/slider interaction.

### Correct solution
Build an **offline availability index/catalog**.

#### Offline catalog builder responsibilities
For a bbox:
1. derive the path set intersecting the bbox,
2. choose chronology tokens (`fToken`) from the known chronology table,
3. probe candidate `i` codes,
4. store only successful `(path, fToken, iCode)` triples,
5. optionally store fully constructed URLs and checksums.

#### Runtime server responsibilities
At request time:
- read the prebuilt catalog,
- return available dates quickly,
- return valid URLs quickly,
- return or fetch cached images quickly.

## Final practical conclusion
To reconstruct all chronologies for a bounding box, the system must discover and store:

`bbox -> paths -> chronology tokens -> valid i codes -> valid URLs`

Not one magic global version code.

## Deliverables created in this conversation

### 1) `tm_metadata_probe.js`
Purpose:
- inspect `dbRoot.v5`,
- attempt heuristic decryption/unpacking of `qp` payloads,
- build an offline catalog of valid `(path, fToken, iCode)` combinations for a bbox.

Subcommands:
- `inspect-root`
- `inspect-qp`
- `build-catalog`

### 2) Runtime server rewrites
A runtime `server_second.js` rewrite was proposed, but because probing live is too slow, the preferred direction is now an **offline catalog builder first**, then a fast runtime reader.

## Further actions recommended

### Highest-value next action
Run the metadata probe script on the collected binaries:
- inspect-root on `D2_dbRoot_v5_tm.proto`
- inspect-qp on `D1_qp_q366.bin` + `D2_dbRoot_v5_tm.proto`

This may reveal whether `q.xxx` and `dbRoot.v5` contain enough catalog information to reduce or replace brute-force discovery.

### Parallel practical action
Use `build-catalog` to create an availability index for a bbox using known chronology tokens and candidate `i` values.

### If metadata route stalls
Keep the catalog-builder approach as the reliable fallback, because the `(path, fToken, iCode)` rule is already experimentally proven.

## Key conclusions to preserve
1. `fXXXX` is the chronology selector.
2. `i.xxx` is a real path-aware imagery/version selector.
3. Exact path matters.
4. Earth-side epochs (`imageryEpoch`, `nodeEpoch`) are useful but are not the same as tm `i.xxx`.
5. A valid historical result is determined by `(path, fToken, iCode)`.
6. Runtime discovery is too slow; use an offline availability catalog.
7. `dbRoot.v5` is structured and likely contains bootstrap/key material.
8. `qp-...-q.xxx` likely contains meaningful packed metadata, but it is not yet decoded into a readable catalog.
