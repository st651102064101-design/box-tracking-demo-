'use strict';
(() => {
const catalogue = {rack:'แร็กตัวอย่าง', safety:'เสา Safety', rail:'ราวกั้น', forklift:'โฟล์คลิฟท์',door:'ประตูหนีไฟ',exit:'ป้าย Exit',pallet:'พาเลท',consumer:'ตู้ Consumer'};
window.warehouseGeometry = function(url, T) {
  const [type,encoded] = url.slice(10).split('?');
  if (!catalogue[type]) throw new Error('อุปกรณ์ไม่รองรับ');
  if(['forklift','door','exit','pallet'].includes(type))return import('./assets.js').then(m=>m.convertAsset(type,T));
  const rack=encoded?JSON.parse(decodeURIComponent(encoded)):null;
  const geometry = new T.Geometry();
  const materials = [0x185c9b,0xe6a338,0x222428].map(color=>new T.MeshPhongMaterial({color}));
  function box(x,y,z,w,h,d,m) {
    const part = new T.BoxGeometry(w,h,d);
    const matrix = new T.Matrix4().makeTranslation(x,y,z);
    part.faces.forEach(face=>{face.materialIndex=m;});
    geometry.merge(part,matrix);
  }
  if(type==='rack') {
    const {width:w,height:h,depth:d}=rack?.dimensionsCm||{width:270,height:300,depth:110};
    // A rack is mostly empty space between thin beams. The invisible box makes
    // the entire visible silhouette a reliable mouse target instead of letting
    // clicks through the gaps rotate the camera.
    materials.push(new T.MeshPhongMaterial({transparent:true,opacity:0,depthWrite:false}));
    box(0,h/2,0,w,h,d,3);
    const shelves=new Map();(rack?.slots||[]).forEach(s=>{const list=shelves.get(s.shelfCode)||[];list.push(s);shelves.set(s.shelfCode,list);});
    const widest=[...shelves.values()].sort((a,b)=>b.length-a.length)[0]||[];widest.sort((a,b)=>a.localPositionCm.x-b.localPositionCm.x);
    const xs=[-(w-7)/2,...widest.slice(1).map((s,i)=>(s.localPositionCm.x+widest[i].localPositionCm.x)/2),(w-7)/2];
    const levels=[...new Set([...shelves.values()].map(s=>s[0].localPositionCm.y-s[0].dimensionsCm.height/2))];if(!levels.length)levels.push(15,100,190);levels.push(h-4);levels.sort((a,b)=>a-b);
    xs.forEach(x=>[-1,1].forEach(s=>{box(x,h/2,s*(d-7)/2,7,h,7,0);box(x,2.5,s*(d-7)/2,16,5,16,0);}));
    levels.forEach(y=>[-1,1].forEach(s=>box(0,y,s*(d-7)/2,w,10.5,9,1)));
    xs.forEach(x=>levels.slice(1).forEach((high,i)=>[-1,1].forEach(sign=>{const a=new T.Vector3(x,levels[i]+7,sign*(d-7)/2),b=new T.Vector3(x,high-7,-sign*(d-7)/2),delta=b.clone().sub(a);const part=new T.BoxGeometry(2.4,delta.length(),2.4);const q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());geometry.merge(part,new T.Matrix4().compose(a.add(b).multiplyScalar(0.5),q,new T.Vector3(1,1,1)));})));
  } else if(type==='safety'||type==='rail') {
    (type==='rail'?[-60,60]:[0]).forEach(x=>{box(x,1.8,0,20,3.5,20,1);const post=new T.CylinderGeometry(5.5,5.5,115,10);post.faces.forEach(f=>{f.materialIndex=1;});geometry.merge(post,new T.Matrix4().makeTranslation(x,57.5,0));[20,52,84].forEach(y=>{const band=new T.CylinderGeometry(5.9,5.9,14,10);band.faces.forEach(f=>{f.materialIndex=2;});geometry.merge(band,new T.Matrix4().makeTranslation(x,y,0));});});
    if(type==='rail') [55,100].forEach(y=>box(0,y,0,120,7,7,1));
  } else if(type==='consumer') {
    materials.push(new T.MeshPhongMaterial({color:0xf0f1ee}),new T.MeshPhongMaterial({color:0xb72024}));
    box(0,45,0,152,90,18,3);box(0,69,5,158,44,23,3);box(0,26,11.5,122,30,3.5,2);
    for(let i=0;i<9;i++){const x=-50+(i<2?i*13:29+(i-2)*13);box(x,26,16,9,19,9,3);box(x,24.5,21.5,5.2,9,5.5,i<2?4:2);}
  } else {
    box(0,55,0,115,65,160,1);box(0,100,-20,70,40,70,2);
    [-50,50].forEach(x=>[-55,55].forEach(z=>box(x,25,z,20,50,45,2)));
    [-45,45].forEach(x=>{box(x,135,-40,6,160,6,2);box(x,135,60,6,160,6,2);});
    box(0,218,10,110,6,115,1);[-35,35].forEach(x=>{box(x,115,90,9,210,9,2);box(x,15,145,12,8,120,2);});
  }
  geometry.faces.forEach(face=>{if(face.materialIndex>=materials.length)face.materialIndex=0;});
  geometry.computeFaceNormals();return {geometry,materials};
};
const app = new Blueprint3d({floorplannerElement:'floorplanner-canvas',threeElement:'#viewer',threeCanvasElement:'three-canvas',textureDir:'',widget:false});
let selected=null;
const status=document.getElementById('status');
let pendingModels=0;
function finishModel(){pendingModels=Math.max(0,pendingModels-1);$('#save').prop('disabled',pendingModels>0);}
app.model.scene.itemLoadingCallbacks.add(()=>{pendingModels++;$('#save').prop('disabled',true);});
app.model.scene.itemLoadedCallbacks.add(finishModel);
window.addEventListener('warehouse-model-error',finishModel);
window.addEventListener('warehouse-model-error',e=>{status.textContent='โหลดโมเดลไม่สำเร็จ: '+e.detail;});
function view(is2d){$('#viewer').toggle(!is2d);$('#floorplanner,#tools').toggle(is2d);$('#view2').toggleClass('active',is2d);$('#view3').toggleClass('active',!is2d);if(is2d)app.floorplanner.reset();else app.three.updateWindowSize();}
$('#view2').click(()=>view(true));$('#view3').click(()=>view(false));
$('[data-mode]').click(function(){app.floorplanner.setMode(app.floorplanner.modes[this.dataset.mode]);});
function addButton(label,url,target='catalog',warehouseAsset=null){const button=document.createElement('button');button.textContent='+ '+label;button.onclick=()=>{view(false);status.textContent='กำลังโหลด '+label;app.model.scene.addItem(1,url,{itemName:label,itemType:1,modelUrl:url,resizable:false,warehouseAsset},null,warehouseAsset?.rotationYDeg*Math.PI/180||0);};document.getElementById(target).append(button);}
Object.entries(catalogue).forEach(([key,label])=>addButton(label,'warehouse:'+key));
app.model.scene.itemLoadedCallbacks.add(()=>{status.textContent='เพิ่มอุปกรณ์แล้ว — ลากเพื่อจัดตำแหน่ง';});
async function loadRacks(){try{const token=localStorage.getItem('smarttrace_jwt');if(!token)throw Error('เข้าสู่ระบบหลักก่อนเพื่อเลือกแร็กจาก DB');const r=await fetch('/api/warehouse-3d',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('โหลดแร็กไม่ได้ ('+r.status+')');const data=await r.json();document.getElementById('db-racks').replaceChildren();data.racks.forEach(rack=>addButton([rack.warehouseId,rack.zone,rack.code].join(' / '),'warehouse:rack?'+encodeURIComponent(JSON.stringify(rack)),'db-racks',rack));status.textContent='โหลดรายการแร็กจาก DB แล้ว';}catch(e){status.textContent=e.message;}}
$('#refresh-racks').click(loadRacks);loadRacks();
$('#done').click(()=>view(false));$('#add-tab').click(()=>{view(false);document.getElementById('catalog').scrollIntoView({block:'nearest'});});
app.floorplanner.modeResetCallbacks.add(mode=>{$('[data-mode]').each(function(){$(this).toggleClass('active',app.floorplanner.modes[this.dataset.mode]===mode);});});
$('#home-view').click(()=>app.three.centerCamera());
$('#zoom-in').click(()=>app.three.controls.dollyIn(1.1));$('#zoom-out').click(()=>app.three.controls.dollyOut(1.1));
app.three.itemSelectedCallbacks.add(item=>{selected=item;$('#selection').prop('hidden',false);$('#name').text(item.metadata.itemName);$('#fixed').prop('checked',item.fixed);});
app.three.itemUnselectedCallbacks.add(()=>{selected=null;$('#selection').prop('hidden',true);});
app.three.itemSelectedCallbacks.add(item=>{const asset=item.metadata.warehouseAsset;const dims=asset?.dimensionsCm;$('#dimensions').text((asset?.id?'รหัส '+asset.id+' • ':'')+'กว้าง '+((dims?.width??item.getWidth())/100).toFixed(2)+' × สูง '+((dims?.height??item.getHeight())/100).toFixed(2)+' × ลึก '+((dims?.depth??item.getDepth())/100).toFixed(2)+' เมตร');$('#angle').val(Math.round(item.rotation.y*180/Math.PI));});
$('#angle').change(function(){if(selected&&!selected.fixed&&Number.isFinite(Number(this.value))){selected.rotation.y=Number(this.value)*Math.PI/180;app.model.scene.needsUpdate=true;}});
$('#rotate').click(()=>{if(selected&&!selected.fixed){selected.rotation.y=(selected.rotation.y+Math.PI/2)%(Math.PI*2);$('#angle').val(Math.round(selected.rotation.y*180/Math.PI));app.model.scene.needsUpdate=true;}});
$('#remove').click(()=>{if(selected){selected.remove();selected=null;$('#selection').prop('hidden',true);}});
$('#fixed').change(function(){if(selected)selected.setFixed(this.checked);});
$('#save').click(()=>{const url=URL.createObjectURL(new Blob([app.model.exportSerialized()],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='warehouse.blueprint3d';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='ส่งออกผังเป็นไฟล์แล้ว';});
$('#load').change(async function(){try{if(!this.files[0])return;const text=await this.files[0].text();const data=JSON.parse(text);if(!data.floorplan||!Array.isArray(data.items)||data.items.some(i=>!catalogue[String(i.model_url).slice(10).split('?')[0]]||!String(i.model_url).startsWith('warehouse:')))throw Error('กรุณาใช้ไฟล์จากตัวจัดคลังนี้');app.model.loadSerialized(text);view(false);status.textContent='เปิดผังแล้ว';}catch(e){status.textContent='เปิดไม่ได้: '+e.message;}this.value='';});
const corners={a:{x:-1000,y:-800},b:{x:1000,y:-800},c:{x:1000,y:800},d:{x:-1000,y:800}};
const texture={url:'texture.svg',stretch:true,scale:0};
app.model.loadSerialized(JSON.stringify({floorplan:{corners,walls:[['a','b'],['b','c'],['c','d'],['d','a']].map(([corner1,corner2])=>({corner1,corner2,frontTexture:texture,backTexture:texture})),wallTextures:[],floorTextures:{},newFloorTextures:{}},items:[]}));
})();
