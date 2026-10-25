import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The scene owns graphics only. Inventory, visibility, cargo and vehicle poses
// are supplied by the isolated engine; the only fetch is this bundled asset.
export function createWarehouseScene(renderer, layout, initialState, signal) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x58666e);
  scene.fog = new THREE.Fog(0x91a0a5, 62, 120);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const instances = new Set();
  const staticMeshes = [];
  const fleet = new Map();
  const shutters = new Map();
  let disposed = false;
  const keepGeometry = geometry => { geometries.add(geometry); return geometry; };
  const keepMaterial = surface => { materials.add(surface); return surface; };
  const material = (color, roughness = 0.72, metalness = 0) => keepMaterial(new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  const unitBox = keepGeometry(new THREE.BoxGeometry(1, 1, 1));
  const unitPlane = keepGeometry(new THREE.PlaneGeometry(1, 1));
  const unitCylinder = keepGeometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  const bounds = layout.floorBounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const eave = 11.8;
  const ridge = 14;
  const roofHeight = x => eave + (ridge - eave) * (1 - Math.abs(x) / (width / 2));
  const surfaces = {
    floor: material(0xc1c5c4, 0.91), seam: material(0x939f9f, 0.95),
    blue: material(0x19609c, 0.5, 0.45), orange: material(0xf18020, 0.52, 0.25),
    steel: material(0x647e8d, 0.5, 0.7), dark: material(0x2c353a, 0.68, 0.4),
    wall: material(0xd4dddf, 0.69, 0.25), lowerWall: material(0xabb6ba, 0.88),
    roof: material(0x56646b, 0.7, 0.45), white: material(0xe5e8e3),
    yellow: material(0xf3c22e, 0.6, 0.25), red: material(0xb83936, 0.5, 0.4),
    wood: material(0x98734b, 0.98), woodLight: material(0xb58c59, 0.95),
    carton: material(0xc49660, 0.98), tape: material(0xe1c28c, 0.9),
    lamp: keepMaterial(new THREE.MeshStandardMaterial({ color: 0xf0f5f3, emissive: 0xd8ecf8, emissiveIntensity: 2.5, roughness: 0.4 })),
    opening: keepMaterial(new THREE.MeshBasicMaterial({ color: 0x233038 })),
  };
  surfaces.roof.side = THREE.DoubleSide;

  function box(size, position, surface, parent = scene, castShadow = true) {
    const mesh = new THREE.Mesh(unitBox, surface);
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (parent === scene) staticMeshes.push(mesh);
    return mesh;
  }
  function member(from, to, radius = 0.055, surface = surfaces.steel) {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const delta = end.clone().sub(start);
    const mesh = new THREE.Mesh(unitCylinder, surface);
    mesh.position.copy(start.add(end).multiplyScalar(0.5));
    mesh.scale.set(radius, delta.length(), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    scene.add(mesh);
    staticMeshes.push(mesh);
    return mesh;
  }
  const signMaterials = new Map();
  function sign(text, size, position, options = {}) {
    const key = `${text}:${options.background}:${options.color}`;
    if (!signMaterials.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = options.background || '#174366';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = options.color || '#f3f4eb';
      ctx.font = '600 94px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 384, 84, 716);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      textures.add(texture);
      signMaterials.set(key, keepMaterial(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })));
    }
    const mesh = new THREE.Mesh(unitPlane, signMaterials.get(key));
    mesh.scale.set(size[0], size[1], 1);
    mesh.position.set(...position);
    mesh.rotation.set(options.floor ? -Math.PI / 2 : 0, options.floor ? 0 : (options.rotationY ?? Math.PI), options.floor ? Math.PI : 0);
    scene.add(mesh);
    staticMeshes.push(mesh);
    return mesh;
  }
  function bollard(x, z) {
    box([0.32, 0.1, 0.32], [x, 0.05, z], surfaces.dark);
    box([0.2, 0.9, 0.2], [x, 0.5, z], surfaces.yellow);
    box([0.205, 0.17, 0.205], [x, 0.65, z], surfaces.dark);
  }
  function floorLine(x, z, w, d) { box([w, 0.008, d], [x, 0.008, z], surfaces.yellow, scene, false); }

  // Fine concrete grain is procedural and local, with repeated saw-cut joints.
  const concrete = document.createElement('canvas');
  concrete.width = concrete.height = 256;
  const concreteContext = concrete.getContext('2d');
  const pixels = concreteContext.createImageData(256, 256);
  let seed = 12345;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const grain = 210 + (seed >>> 27);
    pixels.data[i] = grain; pixels.data[i + 1] = grain + 2; pixels.data[i + 2] = grain; pixels.data[i + 3] = 255;
  }
  concreteContext.putImageData(pixels, 0, 0);
  const concreteTexture = new THREE.CanvasTexture(concrete);
  concreteTexture.wrapS = concreteTexture.wrapT = THREE.RepeatWrapping;
  concreteTexture.repeat.set(width / 2, depth / 2);
  concreteTexture.colorSpace = THREE.SRGBColorSpace;
  textures.add(concreteTexture);
  surfaces.floor.map = concreteTexture;
  box([width, 0.18, depth], [0, -0.09, 0], surfaces.floor, scene, false);
  for (let x = bounds.minX + 5; x < bounds.maxX; x += 5) box([0.018, 0.005, depth], [x, 0.003, 0], surfaces.seam, scene, false);
  for (let z = bounds.minZ + 5; z < bounds.maxZ; z += 5) box([width, 0.005, 0.018], [0, 0.003, z], surfaces.seam, scene, false);

  // The shell is fully enclosed. Both loading portals are actual wall openings;
  // dark recesses conceal the off-stage return route beyond the threshold.
  box([0.2, eave, depth], [bounds.minX, eave / 2, 0], surfaces.wall, scene, false);
  box([0.2, eave, depth], [bounds.maxX, eave / 2, 0], surfaces.wall, scene, false);
  box([width, eave, 0.2], [0, eave / 2, bounds.maxZ], surfaces.wall, scene, false);
  const gates = [
    { id: 'in', x: layout.gateIn.x, text: 'GATE IN', color: '#286653', width: 5.6 },
    { id: 'out', x: layout.gateOut.x, text: 'GATE OUT', color: '#a86b22', width: 5.6 },
  ];
  let wallStart = bounds.minX;
  gates.forEach(gate => {
    const left = gate.x - gate.width / 2;
    const right = gate.x + gate.width / 2;
    box([left - wallStart, eave, 0.2], [(left + wallStart) / 2, eave / 2, bounds.minZ], surfaces.wall, scene, false);
    box([gate.width, eave - 4.8, 0.2], [gate.x, (eave + 4.8) / 2, bounds.minZ], surfaces.wall, scene, false);
    // Recess is deep enough for the entire inbound truck to reverse out of
    // sight before its engine/visibility turn off at the offstage stop.
    const recessDepth = 8;
    box([gate.width, 5, 0.12], [gate.x, 2.5, bounds.minZ - recessDepth], surfaces.opening, scene, false);
    box([0.16, 5, recessDepth], [left, 2.5, bounds.minZ - recessDepth / 2], surfaces.dark, scene, false);
    box([0.16, 5, recessDepth], [right, 2.5, bounds.minZ - recessDepth / 2], surfaces.dark, scene, false);
    box([gate.width, 0.15, recessDepth], [gate.x, 4.8, bounds.minZ - recessDepth / 2], surfaces.dark, scene, false);
    box([gate.width, 0.18, recessDepth], [gate.x, -0.09, bounds.minZ - recessDepth / 2], surfaces.floor, scene, false);
    for (const x of [left, right]) {
      box([0.27, 4.9, 0.4], [x, 2.45, bounds.minZ + 0.08], surfaces.steel);
      bollard(x + (x < gate.x ? -0.38 : 0.38), bounds.minZ + 0.6);
    }
    box([gate.width + 0.6, 0.48, 0.5], [gate.x, 4.9, bounds.minZ], surfaces.steel);
    const shutter = new THREE.Group();
    shutter.name = `simulation-gate-${gate.id}`;
    shutter.position.set(gate.x, 0, bounds.minZ);
    scene.add(shutter);
    const panel = box([gate.width - 0.12, 4.8, 0.1], [0, 2.4, 0], surfaces.steel, shutter);
    const ribs = Array.from({ length: 16 }, (_, i) => box([gate.width - 0.12, 0.035, 0.13], [0, i * 0.3, 0], surfaces.dark, shutter));
    const bottom = box([gate.width - 0.1, 0.09, 0.16], [0, 0.045, 0], surfaces.yellow, shutter);
    shutters.set(gate.id, { root: shutter, panel, ribs, bottom });
    sign(gate.text, [4.4, 0.76], [gate.x, 5.85, bounds.minZ + 0.14], { background: gate.color, rotationY: 0 });
    for (const x of [left + 0.3, right - 0.3]) floorLine(x, bounds.minZ + 2.4, 0.1, 4.8);
    wallStart = right;
  });
  box([bounds.maxX - wallStart, eave, 0.2], [(bounds.maxX + wallStart) / 2, eave / 2, bounds.minZ], surfaces.wall, scene, false);
  for (const side of [-1, 1]) {
    box([0.09, 2.1, depth], [side * (width / 2 - 0.15), 1.05, 0], surfaces.lowerWall, scene, false);
    box([0.12, 0.16, depth], [side * (width / 2 - 0.2), 2.2, 0], surfaces.steel, scene, false);
    for (let z = bounds.minZ + 0.65; z < bounds.maxZ; z += 0.65) box([0.035, eave - 2.3, 0.024], [side * (width / 2 - 0.13), (eave + 2.3) / 2, z], surfaces.lowerWall, scene, false);
  }
  for (let x = bounds.minX + 0.65; x < bounds.maxX; x += 0.65) {
    box([0.024, eave - 2.3, 0.035], [x, (eave + 2.3) / 2, bounds.maxZ - 0.13], surfaces.lowerWall, scene, false);
  }

  function roofPanel(x1, x2, z1, z2) {
    const geometry = keepGeometry(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      x1, roofHeight(x1), z1, x2, roofHeight(x2), z1,
      x2, roofHeight(x2), z2, x1, roofHeight(x1), z2,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    scene.add(new THREE.Mesh(geometry, surfaces.roof));
  }
  roofPanel(-20, -19, -35, 35);
  roofPanel(-15, 0, -35, 35);
  roofPanel(-19, -15, -35, -32);
  roofPanel(-19, -15, -26, 35);
  roofPanel(0, 15, -35, 35);
  roofPanel(19, 20, -35, 35);
  roofPanel(15, 19, -35, -32);
  roofPanel(15, 19, -26, 35);
  // Both descending vehicles have a clear overhead transfer bay.
  for (const centre of [-17, 17]) {
    for (const x of [centre - 2, centre + 2]) member([x, roofHeight(x) - 0.08, -32], [x, roofHeight(x) - 0.08, -26], 0.13, surfaces.yellow);
    for (const z of [-32, -26]) member([centre - 2, roofHeight(centre - 2) - 0.08, z], [centre + 2, roofHeight(centre + 2) - 0.08, z], 0.13, surfaces.yellow);
    sign('OVERHEAD TRANSFER', [3.7, 0.55], [centre, 6.9, -34.85], { background: '#ba8d24', rotationY: 0 });
  }
  for (const z of [bounds.minZ, bounds.maxZ]) {
    const geometry = keepGeometry(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-20, eave, z, 20, eave, z, 0, ridge, z], 3));
    geometry.computeVertexNormals();
    scene.add(new THREE.Mesh(geometry, surfaces.roof));
  }
  for (let z = -34; z <= 34; z += 8.5) {
    for (const side of [-1, 1]) {
      const x = side * 19.7;
      box([0.22, eave, 0.22], [x, eave / 2, z], surfaces.steel);
      member([x, eave - 1.2, z], [x - side * 1.6, eave - 0.3, z], 0.08);
    }
    // Trusses avoid the hoist opening's Z extent.
    for (let x = -20; x < 20; x += 4) {
      const y1 = roofHeight(x) - 0.13;
      const y2 = roofHeight(x + 4) - 0.13;
      member([x, y1, z], [x + 4, y2, z], 0.07);
      member([x, eave - 0.3, z], [x + 4, eave - 0.3, z], 0.065);
      member([x, eave - 0.3, z], [x + 4, y2, z], 0.035);
      member([x + 4, eave - 0.3, z], [x + 4, y2, z], 0.035);
    }
  }
  for (const x of [-15, -10, -5, 0, 5, 10]) member([x, roofHeight(x) - 0.13, -35], [x, roofHeight(x) - 0.13, 35], 0.045);
  for (const x of [-13, 13]) {
    member([x, 11.1, -35], [x, 11.1, 35], 0.05, surfaces.red);
    for (let z = -29; z <= 29; z += 9.7) {
      box([2.1, 0.1, 0.4], [x, 11.3, z], surfaces.dark, scene, false);
      box([1.95, 0.045, 0.32], [x, 11.23, z], surfaces.lamp, scene, false);
      member([x, 11.38, z], [x, roofHeight(x) - 0.2, z], 0.018);
    }
  }
  for (const z of [-16.5, -5.5, 5.5, 16.5, 28]) {
    for (const x of [-4, 4]) {
      box([2.1, 0.1, 0.4], [x, 11.3, z], surfaces.dark, scene, false);
      box([1.95, 0.045, 0.32], [x, 11.23, z], surfaces.lamp, scene, false);
      member([x, 11.38, z], [x, roofHeight(x) - 0.2, z], 0.018);
    }
  }
  scene.add(new THREE.HemisphereLight(0xe2eff7, 0x787c73, 2.25));
  const keyLight = new THREE.DirectionalLight(0xfff2dd, 2.7);
  keyLight.position.set(-12, 18, -24);
  keyLight.target.position.set(0, 0, 1);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  Object.assign(keyLight.shadow.camera, { left: -35, right: 35, top: 45, bottom: -40, near: 0.1, far: 95 });
  keyLight.shadow.normalBias = 0.025;
  keyLight.shadow.bias = -0.0001;
  scene.add(keyLight, keyLight.target);
  const fill = new THREE.DirectionalLight(0xcce6fb, 1.3);
  fill.position.set(16, 10, 28);
  scene.add(fill);

  layout.racks.forEach((rack, row) => {
    const front = rack.z - rack.depth / 2;
    const rear = rack.z + rack.depth / 2;
    const top = Math.max(...rack.shelfHeights) + 1.75;
    const bay = rack.width / 5;
    for (let column = 0; column <= 5; column += 1) {
      const x = rack.x - rack.width / 2 + column * bay;
      for (const z of [front, rear]) {
        box([0.13, top, 0.16], [x, top / 2, z], surfaces.blue);
        box([0.3, 0.045, 0.3], [x, 0.0225, z], surfaces.steel);
        for (let y = 0.35; y < top; y += 0.35) box([0.035, 0.075, 0.008], [x, y, z - 0.083], surfaces.dark, scene, false);
      }
      for (let level = 0; level < 5; level += 1) {
        const y = rack.shelfHeights[level];
        member([x, y, front], [x, Math.min(top, y + 1.75), rear], 0.025, surfaces.blue);
        member([x, y, rear], [x, Math.min(top, y + 1.75), front], 0.025, surfaces.blue);
      }
    }
    rack.shelfHeights.forEach((y, shelf) => {
      for (const z of [front, rear]) box([rack.width, 0.18, 0.13], [rack.x, y - 0.09, z], surfaces.orange);
      rack.slotCenters.forEach((x, slot) => {
        for (const offset of [-1.1, -0.35, 0.35, 1.1]) box([0.06, 0.06, rack.depth], [x + offset, y - 0.03, rack.z], surfaces.steel);
        sign(`${shelf + 1} / ${String(slot + 1).padStart(2, '0')}`, [0.55, 0.13], [x, y - 0.09, front - 0.071], { background: '#ece9d9', color: '#344550' });
      });
    });
    for (const x of [-7.1, 7.1]) sign(`R0${row + 1}`, [1.6, 0.65], [x, top - 0.45, front - 0.1]);
    for (const side of [-1, 1]) {
      const x = rack.x + side * (rack.width / 2 + 0.35);
      for (const z of [front - 0.25, rear + 0.25]) bollard(x, z);
      box([0.12, 0.18, rack.depth + 0.5], [x, 0.55, rack.z], surfaces.yellow);
    }
    floorLine(-9.2, rack.z, 0.09, 8.8);
    floorLine(9.2, rack.z, 0.09, 8.8);
    sign(`AISLE ${row + 1}`, [3.2, 0.65], [0, 0.015, rack.z - 4.8], { floor: true, background: '#bac0ba', color: '#5b6566' });
  });
  for (const x of [-17.7, -16.2]) floorLine(x, 0, 0.08, 64);
  for (let z = -31; z <= 31; z += 5) floorLine(-16.95, z, 1.5, 0.1);
  sign('PEDESTRIAN WALKWAY', [7, 0.85], [-17, 0.016, 29], { floor: true, background: '#bac0ba', color: '#5b6566' });
  const staging = layout.staging || layout.floorPositions[0];
  for (const x of [-1.1, 1.1]) floorLine(staging.x + x, staging.z, 0.08, 2.2);
  for (const z of [-1.1, 1.1]) floorLine(staging.x, staging.z + z, 2.2, 0.08);
  sign('INBOUND / STAGING', [5.7, 0.8], [-12, 0.018, -31.7], { floor: true, background: '#bac0ba', color: '#3b6761' });
  sign('OUTBOUND', [4.3, 0.8], [13, 0.018, -31.7], { floor: true, background: '#bac0ba', color: '#8a692e' });
  sign('WAREHOUSE / 05', [7, 1], [0, 7, -34.85], { rotationY: 0 });
  sign('EXIT', [1.2, 0.45], [18.1, 2.6, 34.85], { background: '#286653' });
  box([1.3, 2.1, 0.08], [18.1, 1.05, 34.84], surfaces.steel);
  box([0.65, 0.04, 0.07], [18.1, 1.03, 34.76], surfaces.white);
  for (const x of [-19.7, 19.7]) {
    box([0.3, 0.85, 0.48], [x, 1.1, 26], surfaces.red);
    member([x, 0.4, 26.4], [x, 11.1, 26.4], 0.055, surfaces.red);
  }

  // Every static cuboid uses a unit mesh, so even small rack perforations and
  // wall ribs collapse into a handful of material batches.
  const batches = new Map();
  staticMeshes.forEach(mesh => {
    const key = `${mesh.geometry.uuid}:${mesh.material.uuid}:${mesh.castShadow}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(mesh);
  });
  batches.forEach(meshes => {
    const batch = new THREE.InstancedMesh(meshes[0].geometry, meshes[0].material, meshes.length);
    batch.castShadow = meshes[0].castShadow;
    batch.receiveShadow = true;
    instances.add(batch);
    meshes.forEach((mesh, index) => { mesh.updateMatrix(); batch.setMatrixAt(index, mesh.matrix); scene.remove(mesh); });
    batch.computeBoundingSphere();
    scene.add(batch);
  });

  function combinedBoxes(parts) {
    const temp = parts.map(([size, position]) => unitBox.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion(), new THREE.Vector3(...size))));
    const geometry = keepGeometry(mergeGeometries(temp));
    temp.forEach(part => part.dispose());
    return geometry;
  }
  const baseParts = [];
  const deckParts = [];
  for (const x of [-0.49, 0, 0.49]) {
    baseParts.push([[0.17, 0.075, 1.1], [x, 0.0375, 0]]);
    for (const z of [-0.44, 0.44]) baseParts.push([[0.17, 0.04, 0.13], [x, 0.095, z]]);
  }
  for (let slat = 0; slat < 6; slat += 1) deckParts.push([[1.2, 0.055, 0.155], [0, 0.1425, -0.47 + slat * 0.188]]);
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 512; labelCanvas.height = 256;
  const labelContext = labelCanvas.getContext('2d');
  labelContext.fillStyle = '#e9e4d5'; labelContext.fillRect(0, 0, 512, 256);
  labelContext.fillStyle = '#35434b'; labelContext.font = 'bold 40px sans-serif'; labelContext.fillText('BOXTRACE', 30, 58);
  labelContext.font = '21px sans-serif'; labelContext.fillText('WAREHOUSE  /  HANDLE WITH CARE', 30, 94);
  for (let x = 32; x < 476; x += 8) if (x % 24 !== 0) labelContext.fillRect(x, 120, x % 5 + 2, 83);
  labelContext.font = '19px monospace'; labelContext.fillText('↑↑    KEEP DRY    □', 30, 238);
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  textures.add(labelTexture);
  const boxLabelMaterial = keepMaterial(new THREE.MeshStandardMaterial({ map: labelTexture, roughness: 0.95 }));
  const frontLabel = new THREE.PlaneGeometry(0.69, 0.34).rotateY(Math.PI).translate(0, 0.76, -0.496);
  const rearLabel = new THREE.PlaneGeometry(0.69, 0.34).translate(0, 0.76, 0.496);
  const labelGeometry = keepGeometry(mergeGeometries([frontLabel, rearLabel]));
  frontLabel.dispose(); rearLabel.dispose();
  const boxComponents = [
    [combinedBoxes(baseParts), surfaces.wood], [combinedBoxes(deckParts), surfaces.woodLight],
    [combinedBoxes([[[1.04, 1.01, 0.98], [0, 0.675, 0]]]), surfaces.carton],
    [combinedBoxes([[[0.095, 0.012, 0.99], [0, 1.186, 0]], [[0.095, 1.01, 0.006], [0, 0.675, -0.493]], [[0.095, 1.01, 0.006], [0, 0.675, 0.493]]]), surfaces.tape],
    [labelGeometry, boxLabelMaterial],
  ].map(([geometry, surface]) => {
    const mesh = new THREE.InstancedMesh(geometry, surface, initialState.boxes.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = surface !== boxLabelMaterial;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    instances.add(mesh); scene.add(mesh);
    return mesh;
  });
  const boxIndices = new Map(initialState.boxes.map((item, i) => [item.id, i]));
  const objectMatrix = new THREE.Object3D();
  const previousBoxes = new Map();

  function collectAsset(model) {
    model.traverse(object => {
      if (!object.isMesh) return;
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach(surface => {
        materials.add(surface);
        Object.values(surface).forEach(value => { if (value?.isTexture) textures.add(value); });
      });
    });
  }
  function disposeResources() {
    instances.forEach(mesh => mesh.dispose());
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(surface => surface.dispose());
    const images = new Set();
    textures.forEach(texture => { if (texture.source?.data?.close) images.add(texture.source.data); texture.dispose(); });
    images.forEach(bitmap => bitmap.close());
    instances.clear(); geometries.clear(); materials.clear(); textures.clear();
  }
  function createTruck(source, snapshot) {
    const model = source.clone(true);
    const root = new THREE.Group();
    root.name = snapshot.id;
    root.userData.attribution = 'Forklift by brezineman (CC BY), same local asset as the live warehouse';
    root.add(model);
    const carriage = model.getObjectByName('ForkliftMastInner');
    const innerMast = model.getObjectByName('ForkliftCarriageForks');
    const outerMast = model.getObjectByName('ForkliftMastOuter');
    if (!carriage || !innerMast || !outerMast) throw new Error('The local forklift model is missing its lift rig.');
    // The original export swaps these names and leaves the forks tilted. Use
    // transforms only; shared mesh vertex buffers and textures stay immutable.
    [carriage, innerMast, outerMast].forEach(mesh => mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    model.updateMatrixWorld(true);
    const raw = new THREE.Box3().setFromObject(model);
    const body = new THREE.Box3().setFromObject(model.getObjectByName('ForkliftBodyTrim'));
    const scale = 2.35 / (body.max.y - raw.min.y);
    const chassisX = (body.min.x + body.max.x) / 2;
    const carriageBounds = new THREE.Box3().setFromObject(carriage);
    carriage.position.x += chassisX - (carriageBounds.min.x + carriageBounds.max.x) / 2;
    const outerBounds = new THREE.Box3().setFromObject(outerMast);
    const innerBounds = new THREE.Box3().setFromObject(innerMast);
    innerMast.position.x += (outerBounds.min.x + outerBounds.max.x - innerBounds.min.x - innerBounds.max.x) / 2;
    model.scale.setScalar(scale);
    model.position.set(-chassisX * scale, -raw.min.y * scale, 1.55 - (carriageBounds.min.z + carriageBounds.max.z) / 2 * scale);
    model.updateMatrixWorld(true);
    // The pallet's fork pockets span y=.075..115 above its underside. Measure
    // the actual blade surface, rather than guessing a mesh-origin lift offset.
    const vertices = carriage.geometry.attributes.position;
    const vertex = new THREE.Vector3();
    const forkBounds = new THREE.Box3().setFromObject(carriage);
    let bladeTop = -Infinity;
    for (let i = 0; i < vertices.count; i += 1) {
      vertex.fromBufferAttribute(vertices, i).applyMatrix4(carriage.matrixWorld);
      if (vertex.z > forkBounds.min.z + (forkBounds.max.z - forkBounds.min.z) * 0.45) bladeTop = Math.max(bladeTop, vertex.y);
    }
    carriage.position.y += (0.105 - bladeTop) / scale;
    const carriageBase = carriage.position.clone();
    const mastBase = innerMast.position.clone();
    // Three nested stages keep the rail connected at the 8.95m top shelf. The
    // extra stages reuse the GLB rail geometry, never stretch its vertices.
    const mastStages = [innerMast];
    for (let i = 1; i <= 2; i += 1) {
      const stage = innerMast.clone();
      stage.name = `${snapshot.id}-mast-stage-${i + 1}`;
      model.add(stage); mastStages.push(stage);
    }
    const wheels = [];
    model.traverse(mesh => {
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
      if (/^Wheel_(FL|FR|RL|RR)$/.test(mesh.name)) wheels.push({ mesh, radius: mesh.userData.wheelRadius * scale });
    });
    if (wheels.length !== 4) throw new Error('The local forklift model is missing wheel pivots.');
    const hoistCables = [];
    if (snapshot.role === 'outbound' || snapshot.role === 'putaway') {
      for (const x of [-0.47, 0.47]) {
        const cable = new THREE.Mesh(unitCylinder, surfaces.dark);
        cable.position.set(x, 0, -0.4);
        root.add(cable); hoistCables.push(cable);
      }
    }
    root.visible = false;
    scene.add(root);
    return { root, carriage, carriageBase, mastStages, mastBase, scale, wheels, hoistCables, previous: null };
  }
  async function loadFleet() {
    const response = await fetch('/models/forklift-wheels.glb', { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error('The warehouse forklift model could not load. Please try again.');
    const buffer = await response.arrayBuffer();
    if (disposed || signal.aborted) return;
    const gltf = await new GLTFLoader().parseAsync(buffer, '/models/');
    collectAsset(gltf.scene);
    if (disposed || signal.aborted) { disposeResources(); return; }
    initialState.forklifts.forEach(snapshot => fleet.set(snapshot.id, createTruck(gltf.scene, snapshot)));
    update(initialState);
  }
  function update(state) {
    if (disposed) return;
    shutters.forEach(({ root, panel, ribs, bottom }, id) => {
      const openness = THREE.MathUtils.clamp(state.gates?.[id] ?? 0, 0, 1);
      const lowerEdge = openness * 4.8;
      const height = 4.8 - lowerEdge;
      root.userData.openness = openness;
      panel.visible = height > 0.001;
      panel.scale.y = Math.max(0.001, height);
      panel.position.y = lowerEdge + height / 2;
      ribs.forEach((rib, i) => {
        rib.position.y = lowerEdge + i * 0.3;
        rib.visible = rib.position.y < 4.77;
      });
      bottom.position.y = lowerEdge + 0.045;
      bottom.visible = openness < 0.999;
    });
    state.forklifts.forEach(snapshot => {
      const rig = fleet.get(snapshot.id);
      if (!rig) return;
      const { position, yaw, liftHeight } = snapshot;
      if (rig.previous && snapshot.visible && rig.previous.visible) {
        const dx = position.x - rig.previous.x;
        const dz = position.z - rig.previous.z;
        const signedDistance = Math.hypot(dx, dz) * Math.sign(dx * Math.sin(yaw) + dz * Math.cos(yaw));
        rig.wheels.forEach(({ mesh, radius }) => { mesh.rotation.x += signedDistance / radius; });
      }
      rig.previous = { x: position.x, z: position.z, visible: snapshot.visible };
      rig.root.visible = snapshot.visible !== false;
      rig.root.position.set(position.x, position.y, position.z);
      rig.root.rotation.y = yaw;
      rig.carriage.position.copy(rig.carriageBase).addScaledVector(new THREE.Vector3(0, 1, 0), liftHeight / rig.scale);
      const extension = Math.max(0, liftHeight - 1.9);
      rig.mastStages.forEach((stage, index) => {
        stage.position.copy(rig.mastBase);
        stage.position.y += extension * (index + 1) / 3 / rig.scale;
        stage.position.z -= index * 0.022 / rig.scale;
      });
      rig.hoistCables.forEach(cable => {
        const length = Math.max(0.01, 19.2 - position.y - 2.35);
        cable.visible = position.y > 0.02;
        cable.scale.set(0.018, length, 0.018);
        cable.position.y = 2.35 + length / 2;
      });
    });
    let boxesChanged = false;
    state.boxes.forEach(snapshot => {
      const index = boxIndices.get(snapshot.id);
      if (index === undefined) throw new Error('The simulation returned an unknown box.');
      const previous = previousBoxes.get(snapshot.id);
      const { position, rotationY, visible } = snapshot;
      if (previous && previous.x === position.x && previous.y === position.y && previous.z === position.z && previous.yaw === rotationY && previous.visible === visible) return;
      objectMatrix.position.set(position.x, position.y, position.z);
      objectMatrix.rotation.set(0, rotationY, 0);
      objectMatrix.scale.setScalar(visible === false ? 0 : 1);
      objectMatrix.updateMatrix();
      boxComponents.forEach(mesh => mesh.setMatrixAt(index, objectMatrix.matrix));
      previousBoxes.set(snapshot.id, { x: position.x, y: position.y, z: position.z, yaw: rotationY, visible });
      boxesChanged = true;
    });
    if (boxesChanged) boxComponents.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
  }
  update(initialState);
  const ready = loadFleet();
  return {
    scene, ready, update, roofHeight,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.clear(); fleet.clear(); shutters.clear(); previousBoxes.clear(); disposeResources();
    },
  };
}
