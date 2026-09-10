"""Render a quick diagnostic preview of a GLB from an isometric camera."""

import sys
from pathlib import Path

import bpy
from mathutils import Vector


source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
destination = Path(sys.argv[sys.argv.index("--") + 2]).resolve()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))

# Optional diagnostic: rotate only the extracted source wheels by 90 degrees.
if "--rotate-wheels" in sys.argv:
    from mathutils import Quaternion
    import math
    wheels = [obj for obj in bpy.context.scene.objects if obj.name in
              {"Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"}]
    assert len(wheels) == 4
    for wheel in wheels:
        wheel.rotation_mode = "QUATERNION"
        wheel.rotation_quaternion = wheel.rotation_quaternion @ Quaternion((1, 0, 0), math.pi / 2)
    bpy.context.view_layer.update()

meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
minimum = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
maximum = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
center = (minimum + maximum) / 2
span = max(maximum - minimum)

bpy.ops.object.camera_add(location=center + Vector((span * 1.6, -span * 2.0, span * 1.15)))
camera = bpy.context.object
camera.data.lens = 58
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=center + Vector((span, -span, span * 2)))
bpy.context.object.data.energy = 1300
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = span * 2
bpy.ops.object.light_add(type="AREA", location=center + Vector((-span, span, span)))
bpy.context.object.data.energy = 700
bpy.context.object.data.size = span

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(destination)
scene.world.color = (0.025, 0.025, 0.025)
bpy.ops.render.render(write_still=True)
