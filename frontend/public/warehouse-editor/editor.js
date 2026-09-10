'use strict';
(() => {
const catalogue = {rack:'แร็กตัวอย่าง', safety:'เสา Safety', rail:'ราวกั้น', forklift:'โฟล์คลิฟท์',door:'ประตูหนีไฟ',exit:'ป้าย Exit',pallet:'พาเลท',consumer:'ตู้ Consumer'};
window.warehouseGeometry = function(url, T) {
  window.warehouseThree=T;
  const [type,encoded] = url.slice(10).split('?');
  if (type==='import') return import('./assets.js').then(m=>m.convertImportedAsset(window.warehouseImportedModels?.get(encoded),T));
  if (!catalogue[type]) throw new Error('อุปกรณ์ไม่รองรับ');
  if(['forklift','door','exit'].includes(type))return import('./assets.js').then(m=>m.convertAsset(type,T));
  const rack=encoded?JSON.parse(decodeURIComponent(encoded)):null;
  const geometry = new T.Geometry();
  const materials = [0x1268cf,0xf28a12,0x222428].map(color=>new T.MeshPhongMaterial({color}));
  function box(x,y,z,w,h,d,m) {
    const part = new T.BoxGeometry(w,h,d);
    const matrix = new T.Matrix4().makeTranslation(x,y,z);
    part.faces.forEach(face=>{face.materialIndex=m;});
    geometry.merge(part,matrix);
  }
  if(type==='rack') {
    const {width:w,height:h,depth:d}=rack?.dimensionsCm||{width:270,height:300,depth:110};
    // This is deliberately the same selective-rack construction used by the
    // production 3D viewer (loc3d.js), ported to Blueprint3D's legacy Geometry
    // API. Rack bays, frames and braces come from the real slot layout.
    materials.push(new T.MeshPhongMaterial({transparent:true,opacity:0,depthWrite:false}));
    box(0,h/2,0,w,h,d,3);
    const frame=Math.min(10,w*.08,d*.08);
    const shelves=new Map();(rack?.slots||[]).forEach(s=>{const list=shelves.get(s.shelfCode)||[];list.push(s);shelves.set(s.shelfCode,list);});
    const widest=[...shelves.values()].sort((a,b)=>b.length-a.length)[0]||[];widest.sort((a,b)=>a.localPositionCm.x-b.localPositionCm.x);
    const xs=[-(w-frame)/2,...widest.slice(1).map((s,i)=>(s.localPositionCm.x+widest[i].localPositionCm.x)/2),(w-frame)/2];
    const levels=[...new Set([...shelves.values()].map(s=>s[0].localPositionCm.y-s[0].dimensionsCm.height/2))];if(!levels.length)levels.push(15,100,190);levels.push(h-4);levels.sort((a,b)=>a-b);
    xs.forEach(x=>[-1,1].forEach(side=>{box(x,h/2,side*(d-frame)/2,frame,h,frame,0);box(x,2.5,side*(d-frame)/2,frame*2.3,5,frame*2.3,0);}));
    levels.forEach(y=>{for(let i=0;i<xs.length-1;i++)[-1,1].forEach(side=>box((xs[i]+xs[i+1])/2,y,side*(d-frame)/2,xs[i+1]-xs[i],10.5,frame*1.28,1));});
    for(let i=0;i<levels.length-1;i++){const low=levels[i]+7,high=levels[i+1]-7;xs.forEach(x=>{const z=(d-frame)/2;const a=new T.Vector3(x,low,-z),b=new T.Vector3(x,high,z),delta=b.clone().sub(a);let part=new T.BoxGeometry(frame*.34,delta.length(),frame*.34),q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());geometry.merge(part,new T.Matrix4().compose(a.add(b).multiplyScalar(.5),q,new T.Vector3(1,1,1)));const c=new T.Vector3(x,low,z),e=new T.Vector3(x,high,-z),other=e.clone().sub(c);part=new T.BoxGeometry(frame*.34,other.length(),frame*.34);q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),other.normalize());geometry.merge(part,new T.Matrix4().compose(c.add(e).multiplyScalar(.5),q,new T.Vector3(1,1,1)));});}
    const boxesBySlot=new Map();(rack?.boxes||[]).forEach(b=>{const list=boxesBySlot.get(b.slotId)||[];list.push(b);boxesBySlot.set(b.slotId,list);});
    (rack?.slots||[]).forEach(slot=>{const placed=boxesBySlot.get(slot.id)||[];placed.forEach((b,i)=>{const bd=b.dimensionsCm||{width:60,height:40,depth:40};const isPallet=/pallet/i.test(b.materialType||'');box(slot.localPositionCm.x+(i-(placed.length-1)/2)*(bd.width+8),slot.localPositionCm.y,0,bd.width,bd.height,bd.depth,isPallet?5:4);});});
  } else if(type==='pallet') {
    // Only the open-deck pallet is available: gaps between the boards are real
    // openings, so the closed plastic pallet from the source asset cannot be added.
    materials.push(new T.MeshPhongMaterial({color:0x9b6236}));
    [-48,-24,0,24,48].forEach(x=>box(x,15,0,18,9,120,3));
    [-48,0,48].forEach(x=>box(x,6,0,22,12,120,3));
    [-42,0,42].forEach(z=>box(0,3,z,120,6,16,3));
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
app.model.scene.itemLoadedCallbacks.add(item=>{if(item.metadata.placeAtDb)item.position.y=item.halfSize.y;});
window.addEventListener('warehouse-model-error',finishModel);
window.addEventListener('warehouse-model-error',e=>{status.textContent='โหลดโมเดลไม่สำเร็จ: '+e.detail;});
function view(is2d){$('#viewer').toggle(!is2d);$('#floorplanner,#tools').toggle(is2d);$('#view2').toggleClass('active',is2d);$('#view3').toggleClass('active',!is2d);if(is2d)app.floorplanner.reset();else app.three.updateWindowSize();}
$('#view2').click(()=>view(true));$('#view3').click(()=>view(false));
$('[data-mode]').click(function(){app.floorplanner.setMode(app.floorplanner.modes[this.dataset.mode]);});
let warehouseData=null;window.warehouseImportedModels=new Map();
function rackLabel(asset){return [asset.warehouseId,asset.zone,asset.code].filter(Boolean).join(' / ');}
function addWarehouseItem(label,url,warehouseAsset=null,position=null){view(false);app.model.scene.addItem(1,url,{itemName:label,itemType:1,modelUrl:url,resizable:false,warehouseAsset,placeAtDb:Boolean(position)},position,warehouseAsset?.rotationYDeg*Math.PI/180||0);}
function addButton(label,url,target='catalog',warehouseAsset=null){const button=document.createElement('button');button.textContent='+ '+label;button.onclick=()=>{status.textContent='กำลังโหลด '+label;addWarehouseItem(label,url,warehouseAsset);};document.getElementById(target).append(button);}
Object.entries(catalogue).forEach(([key,label])=>addButton(label,'warehouse:'+key));
app.model.scene.itemLoadedCallbacks.add(()=>{status.textContent='เพิ่มอุปกรณ์แล้ว — ลากเพื่อจัดตำแหน่ง';});
function attachBoxes(data){const bySlot=new Map();(data.boxes||[]).forEach(box=>{const list=bySlot.get(box.slotId)||[];list.push(box);bySlot.set(box.slotId,list);});data.racks.forEach(rack=>{rack.boxes=rack.slots.flatMap(slot=>(bySlot.get(slot.id)||[]).map(box=>({...box,slotId:slot.id})));});return data;}
async function loadRacks(){try{const token=localStorage.getItem('smarttrace_jwt');if(!token)throw Error('เข้าสู่ระบบหลักก่อนเพื่อเลือกแร็กจาก DB');const r=await fetch('/api/warehouse-3d',{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('โหลดแร็กไม่ได้ ('+r.status+')');const data=attachBoxes(await r.json());warehouseData=data;document.getElementById('db-racks').replaceChildren();data.racks.forEach(rack=>addButton(rackLabel(rack),'warehouse:rack?'+encodeURIComponent(JSON.stringify(rack)),'db-racks',rack));status.textContent=`โหลด DB แล้ว: ${data.stats.racks} แร็ก • ${data.stats.slots} ช่อง • ${data.stats.boxes} กล่อง`;return data;}catch(e){status.textContent=e.message;return null;}}
async function loadDbLayout(){const data=warehouseData||await loadRacks();if(!data)return;app.model.scene.clearItems();data.racks.forEach(rack=>addWarehouseItem(rackLabel(rack),'warehouse:rack?'+encodeURIComponent(JSON.stringify(rack)),rack,{x:rack.positionCm.x,y:0,z:rack.positionCm.z}));status.textContent='กำลังแสดงผังจริงจาก DB';}
function saveFeedback(text,error=false){const feedback=document.getElementById('save-feedback');feedback.textContent=text;feedback.classList.toggle('error',error);}
async function saveDbLayout(){try{const token=localStorage.getItem('smarttrace_jwt');if(!token)throw Error('เข้าสู่ระบบหลักก่อนเพื่อบันทึก');const items=app.model.scene.getItems().filter(item=>item.metadata.warehouseAsset?.id);if(!items.length)throw Error('ยังไม่มีแร็กจาก DB ในผัง');$('#save-db').prop('disabled',true);saveFeedback('กำลังบันทึก…');const results=await Promise.all(items.map(async item=>{const r=await fetch('/api/warehouse-3d/racks/'+encodeURIComponent(item.metadata.warehouseAsset.id),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({positionCm:{x:item.position.x,y:0,z:item.position.z},rotationYDeg:item.rotation.y*180/Math.PI})});if(!r.ok)throw Error(`${item.metadata.itemName}: ${await r.text()||r.status}`);}));status.textContent=`บันทึกตำแหน่ง ${results.length} แร็กลง DB แล้ว`;saveFeedback(`✓ บันทึก ${results.length} แร็กแล้ว`);await loadRacks();}catch(e){status.textContent=e.message;saveFeedback('บันทึกไม่สำเร็จ: '+e.message,true);}finally{$('#save-db').prop('disabled',false);}}
$('#refresh-racks').click(loadRacks);loadRacks();
$('#load-db').click(loadDbLayout);$('#save-db').click(saveDbLayout);
$('#import-model').click(()=>document.getElementById('model-file').click());
$('#model-file').change(function(){const file=this.files?.[0];if(!file)return;const id=(crypto.randomUUID?.()||Date.now().toString());window.warehouseImportedModels.set(id,file);status.textContent='กำลังนำเข้า '+file.name;addWarehouseItem(file.name,'warehouse:import?'+id);this.value='';});
$('#done').click(()=>view(false));$('#add-tab').click(()=>{view(false);document.getElementById('catalog').scrollIntoView({block:'nearest'});});
app.floorplanner.modeResetCallbacks.add(mode=>{$('[data-mode]').each(function(){$(this).toggleClass('active',app.floorplanner.modes[this.dataset.mode]===mode);});});
$('#home-view').click(()=>app.three.centerCamera());
function zoomCamera(factor){app.three.controls.dollyIn(factor);app.three.controls.update();}
function zoomOutCamera(factor){app.three.controls.dollyOut(factor);app.three.controls.update();}
$('#zoom-in').click(()=>zoomCamera(1.18));$('#zoom-out').click(()=>zoomOutCamera(1.18));
app.three.itemSelectedCallbacks.add(item=>{selected=item;$('#selection').prop('hidden',false);$('#name').text(item.metadata.itemName);$('#fixed').prop('checked',item.fixed);});
app.three.itemUnselectedCallbacks.add(()=>{selected=null;$('#selection').prop('hidden',true);});
app.three.itemSelectedCallbacks.add(item=>{const asset=item.metadata.warehouseAsset;const dims=asset?.dimensionsCm;$('#dimensions').text((asset?.id?'รหัส '+asset.id+' • ':'')+'กว้าง '+((dims?.width??item.getWidth())/100).toFixed(2)+' × สูง '+((dims?.height??item.getHeight())/100).toFixed(2)+' × ลึก '+((dims?.depth??item.getDepth())/100).toFixed(2)+' เมตร');$('#angle').val(Math.round(item.rotation.y*180/Math.PI));const list=document.getElementById('slot-list');list.replaceChildren();if(asset?.slots?.length){asset.slots.forEach(slot=>{const boxes=(asset.boxes||[]).filter(box=>box.slotId===slot.id);const row=document.createElement('div');row.className='slot-row'+(boxes.length?' full':'');row.textContent=slot.barcode+' • '+(boxes.length?boxes.map(box=>box.id).join(', '):'ว่าง');list.append(row);});}});
$('#angle').change(function(){if(selected&&!selected.fixed&&Number.isFinite(Number(this.value))){selected.rotation.y=Number(this.value)*Math.PI/180;app.model.scene.needsUpdate=true;}});
$('#rotate').click(()=>{if(selected&&!selected.fixed){selected.rotation.y=(selected.rotation.y+Math.PI/2)%(Math.PI*2);$('#angle').val(Math.round(selected.rotation.y*180/Math.PI));app.model.scene.needsUpdate=true;}});
$('#remove').click(()=>{if(selected){selected.remove();selected=null;$('#selection').prop('hidden',true);}});
$('#fixed').change(function(){if(selected)selected.setFixed(this.checked);});
$('#save').click(()=>{const url=URL.createObjectURL(new Blob([app.model.exportSerialized()],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='warehouse.blueprint3d';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='ส่งออกผังเป็นไฟล์แล้ว';});
$('#load').change(async function(){try{if(!this.files[0])return;const text=await this.files[0].text();const data=JSON.parse(text);if(!data.floorplan||!Array.isArray(data.items)||data.items.some(i=>!catalogue[String(i.model_url).slice(10).split('?')[0]]||!String(i.model_url).startsWith('warehouse:')))throw Error('กรุณาใช้ไฟล์จากตัวจัดคลังนี้');app.model.loadSerialized(text);view(false);status.textContent='เปิดผังแล้ว';}catch(e){status.textContent='เปิดไม่ได้: '+e.message;}this.value='';});
const corners={a:{x:-2500,y:-2000},b:{x:2500,y:-2000},c:{x:2500,y:2000},d:{x:-2500,y:2000}};
const texture={url:'texture.svg',stretch:true,scale:0};
app.model.loadSerialized(JSON.stringify({floorplan:{corners,walls:[['a','b'],['b','c'],['c','d'],['d','a']].map(([corner1,corner2])=>({corner1,corner2,frontTexture:texture,backTexture:texture})),wallTextures:[],floorTextures:{},newFloorTextures:{}},items:[]}));
})();
