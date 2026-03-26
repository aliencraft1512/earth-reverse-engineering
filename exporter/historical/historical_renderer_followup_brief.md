# Agent Follow-Up Brief — Historical Renderer Refinements After Latest Update

## Context

The latest update already fixed the major earlier issues:

- bounds-aware dynamic catalog is now in the main `historical/` flow
- same-date multi-version sidebar identity is fixed using a unique entry key
- XYZ requests now use tile center instead of tile corner
- ancestor fallback no longer returns the raw parent tile directly; it now crops/resamples by suffix and caches derived tiles
- the frontend now distinguishes between:
  - exact selected version
  - server-chosen best valid version per path

This follow-up should **not** redo those solved items or revert the architecture.

## Current conclusion

The project is now on the right path.

Dynamic acquisition should remain the primary truth source, and the current bounds-aware catalog + path-aware rendering direction should be preserved.

The remaining work is now about **fidelity, provenance, and cleanup**, not about rethinking the whole system again.

## Required direction for this next pass

### 1. Add a strict fidelity mode

The current crop-based ancestor fallback is much better than before, but it is still a fallback approximation.

Implement an explicit rendering mode distinction such as:

- **native-only**
- **allow ancestor-derived**

In strict/native mode:
- do not render tiles that required ancestor crop fallback

In fallback-allowed mode:
- current behavior may continue

This is important because a cropped ancestor tile is not identical to a true native leaf tile.

### 2. Improve duplicate-version handling

The system now keeps date/version/path identity correctly, which is good.

The next step is to detect or annotate cases where:
- same date
- different `iCode`
- same actual content

If hashes/signatures are available or can be derived safely, use them to:
- collapse equivalent entries, or
- mark them as duplicate-equivalent in the UI/debug output

Goal:
reduce confusing version duplication where multiple `iCode` values resolve to effectively the same image content.

### 3. Surface provenance more clearly in the UI

The backend now exposes useful provenance signals, including:
- requested path
- resolved path
- chosen version
- whether cropping/fallback happened

Expose more of this meaningfully in the frontend.

At minimum, provide view-level visibility for:
- how many visible tiles resolved exactly
- how many used ancestor-derived fallback
- whether the current view is mixed-version
- which mode is currently active:
  - exact version
  - best valid version per path
  - native-only / fallback-allowed

This is not only for debugging — it improves trust in the rendered result.

### 4. Keep the current architecture direction

Do not revert back to the older assumptions.

Preserve:
- bounds-aware dynamic discovery
- path-aware metadata lookup
- unique entry identity using date/version/token
- crop-aware ancestor fallback
- exact-vs-best-per-path selection logic

The next pass should refine this architecture, not replace it.

## What not to do

Do **not**:
- flatten the model back into date-only selection
- remove path-aware provenance
- reintroduce raw ancestor-tile stamping
- replace dynamic discovery with chronology-first hardcoding
- ask the frontend to pretend everything is one clean global version per date

## Suggested implementation targets

Primary files to inspect/refine:

- `exporter/historical/HistoricalServer.js`
- `exporter/historical/catalog.js`
- `exporter/historical/tileCropper.js`
- `exporter/historical/public/app.js`

Possible supporting areas:
- metadata/hash/signature handling
- UI status/debug summaries
- selection/render mode controls

## Validation expectations

The next pass should demonstrate:

1. a strict/native-only render mode exists
2. ancestor-derived tiles can be counted and optionally excluded
3. duplicate-equivalent versions are either collapsed or clearly annotated
4. provenance is visible enough that the user can tell what the renderer actually did
5. the current bounds-aware dynamic model remains intact

## Final instruction

**Do not redo the already-solved architectural fixes. Focus only on fidelity controls, duplicate-version clarity, and stronger provenance visibility on top of the current bounds-aware dynamic rendering model.**
