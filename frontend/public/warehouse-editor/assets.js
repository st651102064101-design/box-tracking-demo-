import * as Modern from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const files = {forklift:'forklift.glb',door:'fire_exit_door.glb',exit:'emergency_exit_low_poly.glb'};
const cache = new Map();
function convertScene(scene,T,desiredSize=120) {
  scene.updateMatrixWorld(true);
  const size = new Modern.Box3().setFromObject(scene).getSize(new Modern.Vector3());
  const scale = desiredSize/Math.max(size.x,size.y,size.z);
  const geometry = new T.Geometry(), materials=[];
  scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const source=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();
    source.applyMatrix4(mesh.matrixWorld);source.scale(scale,scale,scale);
    const pos=source.attributes.position,uv=source.attributes.uv;
    const original=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    const materialBase=materials.length;
    original.forEach(m=>{
      const color=m.color.clone().convertLinearToSRGB();
      const mat=new T.MeshPhongMaterial({color:color.getHex(),side:T.DoubleSide,transparent:m.transparent,opacity:m.opacity});
      if(m.map?.image){const texture=new T.Texture(m.map.image);texture.flipY=m.map.flipY;texture.needsUpdate=true;mat.map=texture;}
      materials.push(mat);
    });
    const offset=geometry.vertices.length;
    for(let i=0;i<pos.count;i++)geometry.vertices.push(new T.Vector3(pos.getX(i),pos.getY(i),pos.getZ(i)));
    for(let i=0;i<pos.count;i+=3){const group=source.groups.find(g=>i>=g.start&&i<g.start+g.count);const face=new T.Face3(offset+i,offset+i+1,offset+i+2);face.materialIndex=materialBase+(group?.materialIndex||0);geometry.faces.push(face);geometry.faceVertexUvs[0].push([0,1,2].map(j=>new T.Vector2(uv?uv.getX(i+j):0,uv?uv.getY(i+j):0)));}
    source.dispose();
  });
  geometry.computeFaceNormals();geometry.computeVertexNormals();return {geometry,materials};
}
export async function convertAsset(type, T) {
  if (!files[type]) throw Error('ไม่พบโมเดล');
  if(!cache.has(type)) cache.set(type,new GLTFLoader().loadAsync('/models/'+files[type]).catch(e=>{cache.delete(type);throw e;}));
  const {scene} = await cache.get(type);
  const desiredSize=type==='forklift'?325:type==='door'?210:60;
  return convertScene(scene,T,desiredSize);
}
export async function convertImportedAsset(file,T) {
  if(!file || !/\.glb$/i.test(file.name)) throw Error('รองรับการนำเข้าไฟล์ .glb เท่านั้น');
  const url=URL.createObjectURL(file);
  try { const {scene}=await new GLTFLoader().loadAsync(url);return convertScene(scene,T,150); }
  finally { URL.revokeObjectURL(url); }
}
