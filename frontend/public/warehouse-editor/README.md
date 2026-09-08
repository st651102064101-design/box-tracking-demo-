# Warehouse editor prototype

Open `/warehouse-editor/index.html`. Isolated legacy Blueprint3D runtime;
does not mutate production rack/location records. Save/open downloads local
Blueprint3D JSON. Catalogue models are original procedural warehouse proxies.

Vendor: https://furnishup.github.io/blueprint3d/example/js/blueprint3d.js
retrieved 2026-09-08; browserified upstream runtime includes Three.js r69,
jQuery and dependencies with embedded license notices. FurnishUp MIT license
is preserved in vendor/LICENSE.txt. jQuery copied from furnishup/blueprint3d.
Local changes: warehouse geometry factory hook and local neutral textures.

Pending production integration: authenticated shared DB layouts, real rack
identities/dimensions, forklift GLB conversion, zones, aisles and undo/redo.
