"""Prepare the separated low-position forklift as a runtime-controllable GLB."""

import sys
from pathlib import Path

import bpy
from mathutils import Vector


source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
destination = Path(sys.argv[sys.argv.index("--") + 2]).resolve()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))

objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if len(objects) != 12:
    raise RuntimeError(f"expected 12 forklift meshes, found {len(objects)}")

names = [
    "ForkliftBase",
    "ForkliftDetailA",
    "ForkliftTank",
    "ForkliftWheelPairRear",
    "ForkliftWheelPairFront",
    "ForkliftDetailB",
    "ForkliftMastInner",
    "ForkliftMastOuter",
    "ForkliftCarriageForks",
    "ForkliftDetailC",
    "ForkliftBody",
    "ForkliftBodyTrim",
]

for obj, name in zip(objects, names):
    obj.name = name
    obj.data.name = name

# Put each wheel pair's origin at its own geometric centre. The geometry stays
# exactly where authored, while Three.js gets a safe axle pivot for rotation.
for obj in (objects[3], objects[4]):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    bpy.context.scene.cursor.location = sum(corners, Vector()) / 8
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
    obj.select_set(False)

bpy.ops.object.select_all(action="SELECT")
destination.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(destination),
    export_format="GLB",
    use_selection=True,
    export_animations=False,
    export_cameras=False,
    export_lights=False,
)
print(f"EXPORTED {destination}")
