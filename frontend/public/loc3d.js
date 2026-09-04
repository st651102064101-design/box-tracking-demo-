import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let disposeCurrent = null;
const natural = (a,b) => String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'});

function mount(canvas, locations, occupancy, onSelect){
  if(!canvas)return;
  if(disposeCurrent)disposeCurrent();
  const stage=canvas.parentElement, scene=new THREE.Scene();
  scene.background=new THREE.Color(0x111316);
  scene.fog=new THREE.Fog(0x111316,28,72);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  const camera=new THREE.PerspectiveCamera(48,1,.1,160);
  const controls=new OrbitControls(camera,canvas);
  controls.enableDamping=true;controls.dampingFactor=.07;controls.maxPolarAngle=Math.PI*.49;controls.minDistance=5;controls.maxDistance=65;
  scene.add(new THREE.HemisphereLight(0xdbe8ff,0x20242a,2.2));
  const sun=new THREE.DirectionalLight(0xffffff,3.4);sun.position.set(-12,18,8);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);scene.add(sun);
  const root=new THREE.Group();scene.add(root);
  const grouped=new Map();
  locations.forEach(l=>{const key=`${l.zone}\0${l.rack}`;if(!grouped.has(key))grouped.set(key,{zone:l.zone,rack:l.rack,rows:[]});grouped.get(key).rows.push(l);});
  const racks=[...grouped.values()].sort((a,b)=>natural(a.zone,b.zone)||natural(a.rack,b.rack));
  const rackDepth=1.25,slotW=1.05,shelfH=.9,aisle=3.8,zoneGap=4;
  const zones=[...new Set(racks.map(r=>r.zone))];let cursorX=0,maxDepth=8;
  const clickable=[];
  const matSteel=new THREE.MeshStandardMaterial({color:0x67717d,metalness:.72,roughness:.34});
  const matShelf=new THREE.MeshStandardMaterial({color:0x343a42,metalness:.55,roughness:.5});
  const matEmpty=new THREE.MeshStandardMaterial({color:0x9cff1f,transparent:true,opacity:.16,roughness:.55});
  const matOccupied=new THREE.MeshStandardMaterial({color:0x9cff1f,emissive:0x294c00,emissiveIntensity:.7,roughness:.42});
  const box=(w,h,d,mat,x,y,z)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;root.add(m);return m;};
  zones.forEach((zone,zi)=>{
    const zr=racks.filter(r=>r.zone===zone);const cols=Math.max(1,Math.ceil(Math.sqrt(zr.length)));
    zr.forEach((rk,i)=>{
      const shelves=[...new Set(rk.rows.map(l=>String(l.shelf||'1')))].sort(natural),slots=[...new Set(rk.rows.map(l=>String(l.slot||'1')))].sort(natural);
      const width=Math.max(1,slots.length)*slotW,x=cursorX+(i%cols)*(width+aisle),z=Math.floor(i/cols)*(rackDepth+aisle);
      maxDepth=Math.max(maxDepth,z+rackDepth+4);const height=Math.max(1,shelves.length)*shelfH+.35;
      [-width/2,width/2].forEach(px=>box(.1,height,rackDepth,matSteel,x+px,height/2,z));
      shelves.forEach((sh,sy)=>{const y=.18+(sy+1)*shelfH;box(width+.12,.09,rackDepth+.08,matShelf,x,y,z);
        slots.forEach((sl,sx)=>{const l=rk.rows.find(v=>String(v.shelf||'1')===sh&&String(v.slot||'1')===sl);if(!l)return;const cell=box(slotW-.12,shelfH-.18,rackDepth-.18,occupancy[l.code]?matOccupied:matEmpty,x-width/2+slotW*(sx+.5),y-shelfH/2+.03,z);cell.userData.code=l.code;clickable.push(cell);});});
    });
    const widest=zr.reduce((n,r)=>Math.max(n,new Set(r.rows.map(l=>l.slot)).size*slotW),1);cursorX+=Math.max(cols*(widest+aisle),8)+zoneGap;
  });
  const floorW=Math.max(cursorX+5,18),floorD=Math.max(maxDepth,16);box(floorW,.18,floorD,new THREE.MeshStandardMaterial({color:0x252a30,roughness:.86}),floorW/2-3,-.1,floorD/2-3);
  const grid=new THREE.GridHelper(Math.max(floorW,floorD),Math.ceil(Math.max(floorW,floorD)),0x53606d,0x343b43);grid.position.set(floorW/2-3,.01,floorD/2-3);root.add(grid);
  camera.position.set(floorW*.48,Math.max(8,floorW*.28),floorD*1.05);controls.target.set(floorW*.42,1.5,floorD*.32);controls.update();
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
  function pick(e){const r=canvas.getBoundingClientRect();pointer.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(clickable,false)[0];if(hit&&onSelect)onSelect(hit.object.userData.code);}
  let down=null;function pointerDown(e){down={x:e.clientX,y:e.clientY};}function pointerUp(e){if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<5)pick(e);down=null;}
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointerup',pointerUp);
  function resize(){const w=Math.max(stage.clientWidth,320),h=Math.max(stage.clientHeight,520);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const ro=new ResizeObserver(resize);ro.observe(stage);resize();let raf=0,live=true;
  function frame(){if(!live)return;controls.update();renderer.render(scene,camera);raf=requestAnimationFrame(frame);}frame();
  stage.querySelector('.loc3d-loading')?.remove();
  disposeCurrent=()=>{live=false;cancelAnimationFrame(raf);ro.disconnect();canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointerup',pointerUp);controls.dispose();renderer.dispose();scene.traverse(o=>{o.geometry?.dispose();if(o.material&&!Array.isArray(o.material))o.material.dispose();});};
}

window.LocationWarehouse3D={mount};
