"""Print mesh bounds and hierarchy to identify animatable forklift parts."""

import sys
from pathlib import Path

import bpy
from mathutils import Vector


source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))

for obj in [item for item in bpy.context.scene.objects if item.type == "MESH"]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
    maximum = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
    center = (minimum + maximum) / 2
    size = maximum - minimum
    print(
        "PART",
        obj.name,
        "mesh=", obj.data.name,
        "verts=", len(obj.data.vertices),
        "center=", tuple(round(v, 4) for v in center),
        "size=", tuple(round(v, 4) for v in size),
        "parent=", obj.parent.name if obj.parent else "-",
    )
