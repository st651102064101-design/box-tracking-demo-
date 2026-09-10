// Offline, lossless partition of the source's textured tyre/hub assembly.
// Run from repository root: node scripts/build-forklift-wheels.cjs
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { gltf, binary, values } = require('./forklift-wheel-components.cjs');
const node = gltf.nodes.find(n => n.name === 'ForkliftBase');
assert(node, 'Source wheel assembly missing');
const primitive = gltf.meshes[node.mesh].primitives[0];
const positions = values(primitive.attributes.POSITION);
const indices = values(primitive.indices).flat();
const parts = Array.from({length:4},()=>[]);
const part = i => (positions[i][1] < -1 ? 0 : 2) + (positions[i][0] < 0 ? 0 : 1);
for(let i=0;i<indices.length;i+=3){
  const tri=indices.slice(i,i+3), p=part(tri[0]);
  assert(tri.every(v=>part(v)===p), 'Triangle crosses wheel partitions');
  parts[p].push(...tri);
}
const chunks=[binary]; let offset=binary.length;
function accessor(rows,type){
  const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}
  const flat=rows.flat(), data=Buffer.alloc(flat.length*4);
  flat.forEach((v,i)=>type==='SCALAR'?data.writeUInt32LE(v,i*4):data.writeFloatLE(v,i*4));
  const view=gltf.bufferViews.push({buffer:0,byteOffset:offset,byteLength:data.length})-1;
  chunks.push(data);offset+=data.length;
  const a={bufferView:view,componentType:type==='SCALAR'?5125:5126,count:rows.length,type};
  if(type==='VEC3') { a.min=[0,1,2].map(k=>Math.min(...rows.map(r=>r[k])));a.max=[0,1,2].map(k=>Math.max(...rows.map(r=>r[k]))); }
  return gltf.accessors.push(a)-1;
}
const attributes=Object.fromEntries(Object.entries(primitive.attributes).map(([key,index])=>[key,values(index)]));
const names=['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR'];
node.children=[]; delete node.mesh;
let count=0;
parts.forEach((subset,p)=>{
  assert(subset.length>1000,'Unexpected wheel geometry');count+=subset.length;
  const ids=[...new Set(subset)], remap=new Map(ids.map((id,i)=>[id,i]));
  const min=[0,1,2].map(k=>Math.min(...ids.map(i=>positions[i][k])));
  const max=[0,1,2].map(k=>Math.max(...ids.map(i=>positions[i][k])));
  const pivot=min.map((v,k)=>(v+max[k])/2), radius=(max[2]-min[2])/2;
  assert(radius>.2 && radius<.28,'Unexpected tyre radius');
  const attrs={};
  for(const [key,rows] of Object.entries(attributes)){
    const selected=ids.map(id=>rows[id].map((v,k)=>key==='POSITION'?v-pivot[k]:v));
    attrs[key]=accessor(selected,selected[0].length===2?'VEC2':'VEC3');
    // Verify bind-pose geometry is unchanged (within float32 precision).
    if(key==='POSITION')selected.forEach((v,i)=>v.forEach((x,k)=>assert(Math.abs(x+pivot[k]-positions[ids[i]][k])<1e-7)));
  }
  const mesh=gltf.meshes.push({name:names[p],primitives:[{...primitive,attributes:attrs,indices:accessor(subset.map(i=>[remap.get(i)]),'SCALAR')}]})-1;
  node.children.push(gltf.nodes.push({name:names[p],mesh,translation:pivot,extras:{wheelRadius:radius}})-1);
  console.log(names[p],subset.length/3,'triangles, radius',radius);
});
assert.equal(count,indices.length,'All original wheel triangles must be preserved exactly once');
const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}
gltf.buffers[0].byteLength=offset;
const json=Buffer.from(JSON.stringify(gltf)), jsonPad=Buffer.alloc((4-json.length%4)%4,32);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+jsonPad.length+offset,8);header.writeUInt32LE(json.length+jsonPad.length,12);header.writeUInt32LE(0x4e4f534a,16);
const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(offset);binHeader.writeUInt32LE(0x004e4942,4);
fs.writeFileSync('frontend/public/models/forklift-wheels.glb',Buffer.concat([header,json,jsonPad,binHeader,...chunks]));
