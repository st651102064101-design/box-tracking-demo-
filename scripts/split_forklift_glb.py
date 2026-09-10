"""Split the three forklift assemblies bundled in FORKLIP.glb.

Run with Blender in background mode:
  blender --background --factory-startup --python scripts/split_forklift_glb.py -- SOURCE OUTPUT_DIR
"""

import sys
from pathlib import Path

import bpy


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 2:
        raise SystemExit("expected SOURCE.glb OUTPUT_DIR")

    source = Path(args[0]).resolve()
    output_dir = Path(args[1]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(source))
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(mesh_objects) != 36:
        raise RuntimeError(f"expected 36 mesh objects, found {len(mesh_objects)}")

    # The source contains three consecutive, structurally identical sets of
    # 12 meshes. Export each set independently while preserving its materials,
    # embedded textures and authored transforms.
    for group_index in range(3):
        bpy.ops.object.select_all(action="DESELECT")
        group = mesh_objects[group_index * 12 : (group_index + 1) * 12]
        for obj in group:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        destination = output_dir / f"FORKLIP_{group_index + 1:02d}.glb"
        bpy.ops.export_scene.gltf(
            filepath=str(destination),
            export_format="GLB",
            use_selection=True,
            export_animations=False,
            export_cameras=False,
            export_lights=False,
        )
        print(f"EXPORTED {destination} ({len(group)} meshes)")


if __name__ == "__main__":
    main()
