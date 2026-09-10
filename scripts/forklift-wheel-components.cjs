const fs = require('node:fs');
const source = process.argv[2] || 'frontend/public/models/forklift-rigged.glb';
const file = fs.readFileSync(source);
const jsonSize = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + jsonSize));
const binary = file.subarray(28 + jsonSize);
function values(index) {
  const a = gltf.accessors[index], v = gltf.bufferViews[a.bufferView];
  const width = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
  const bytes = {5126:4,5125:4,5123:2,5121:1}[a.componentType];
  const read = {5126:'readFloatLE',5125:'readUInt32LE',5123:'readUInt16LE',5121:'readUInt8'}[a.componentType];
  return Array.from({length:a.count}, (_, i) => Array.from({length:width}, (_, k) => binary[read]((v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||width*bytes)+k*bytes)));
}
module.exports = { gltf, binary, values };
if (require.main === module) for (const node of gltf.nodes) {
  if (node.mesh == null) continue;
  for (const [pi, primitive] of gltf.meshes[node.mesh].primitives.entries()) {
    const pos=values(primitive.attributes.POSITION), idx=values(primitive.indices).flat();
    const parent=pos.map((_,i)=>i), weld=new Map();
    const root=i=>parent[i]===i?i:(parent[i]=root(parent[i]));
    const join=(a,b)=>{parent[root(a)]=root(b);};
    pos.forEach((p,i)=>{const key=p.map(x=>Math.round(x*1e5)).join(','); if(weld.has(key))join(i,weld.get(key));else weld.set(key,i);});
    for(let i=0;i<idx.length;i+=3){join(idx[i],idx[i+1]);join(idx[i],idx[i+2]);}
    const groups=new Map();
    idx.forEach(i=>{const r=root(i);if(!groups.has(r))groups.set(r,new Set());groups.get(r).add(i);});
    for(const ids of groups.values()){
      if(ids.size<25)continue;
      const min=[0,1,2].map(k=>Math.min(...[...ids].map(i=>pos[i][k]))),max=[0,1,2].map(k=>Math.max(...[...ids].map(i=>pos[i][k])));
      console.log(node.name,pi,ids.size,'center',min.map((x,k)=>(x+max[k])/2).map(x=>x.toFixed(4)).join(','),'size',min.map((x,k)=>max[k]-x).map(x=>x.toFixed(4)).join(','));
    }
  }
}
