# Warehouse editor prototype

Open `/warehouse-editor/index.html`. Isolated legacy Blueprint3D runtime;
does not mutate production rack/location records. Save/open downloads local
Blueprint3D JSON. Catalogue models are original procedural warehouse proxies.

Vendor: https://furnishup.github.io/blueprint3d/example/js/blueprint3d.js
retrieved 2026-09-08; browserified upstream runtime includes Three.js r69,
jQuery and dependencies with embedded license notices. FurnishUp MIT license
is preserved in vendor/LICENSE.txt. jQuery copied from furnishup/blueprint3d.
Local changes: warehouse geometry factory hook and local neutral textures.

The catalogue reads authenticated /api/warehouse-3d rack geometry. Rack IDs and
dimension/slot snapshots travel in the model URL and in explicit
`warehouse_asset` metadata, so identity, master dimensions and the original
rotation survive file round trips.
GLBs from /models are converted to legacy geometry on demand by assets.js;
the converter uses Three.js 0.184.0 via the same CDN as the warehouse viewer.
Procedural rack frames use DB shelf and bay dimensions. Consumer and safety
geometry reproduce the warehouse dimensions. PBR rendering differs in r69.
Warehouse catalogue items validate dragging by their centre point, allowing
long racks to move throughout a room without Blueprint3D's red invalid ghost.

Pending production integration: shared DB layouts, zones, aisles and undo/redo.
