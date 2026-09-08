'use strict';
(() => {
const catalogue = {rack:'แร็ก', safety:'เสา Safety', rail:'ราวกั้น', forklift:'โฟล์คลิฟท์ (แบบจำลอง)'};
window.warehouseGeometry = function(url, T) {
  const type = url.slice(10);
  if (!catalogue[type]) throw new Error('อุปกรณ์ไม่รองรับ');
  const geometry = new T.Geometry();
  const materials = [0x185c9b,0xe6a338,0x222428].map(color=>new T.MeshPhongMaterial({color}));
  function box(x,y,z,w,h,d,m) {
    const part = new T.BoxGeometry(w,h,d);
    const matrix = new T.Matrix4().makeTranslation(x,y,z);
    part.faces.forEach(face=>{face.materialIndex=m;});
    geometry.merge(part,matrix);
  }
  if(type==='rack') {
    [-135,135].forEach(x=>[-55,55].forEach(z=>box(x,150,z,7,300,7,0)));
    [15,100,190,280].forEach(y=>{[-55,55].forEach(z=>box(0,y,z,270,9,7,1));box(0,y-4,0,270,3,110,2);});
  } else if(type==='safety'||type==='rail') {
    (type==='rail'?[-60,60]:[0]).forEach(x=>{box(x,3,0,20,6,20,1);box(x,58,0,10,110,10,1);[25,55,85].forEach(y=>box(x,y,0,11,14,11,2));});
    if(type==='rail') [55,100].forEach(y=>box(0,y,0,120,7,7,1));
  } else {
    box(0,55,0,115,65,160,1);box(0,100,-20,70,40,70,2);
    [-50,50].forEach(x=>[-55,55].forEach(z=>box(x,25,z,20,50,45,2)));
    [-45,45].forEach(x=>{box(x,135,-40,6,160,6,2);box(x,135,60,6,160,6,2);});
    box(0,218,10,110,6,115,1);[-35,35].forEach(x=>{box(x,115,90,9,210,9,2);box(x,15,145,12,8,120,2);});
  }
  geometry.computeFaceNormals();return {geometry,materials};
};
const app = new Blueprint3d({floorplannerElement:'floorplanner-canvas',threeElement:'#viewer',threeCanvasElement:'three-canvas',textureDir:'',widget:false});
let selected=null;
const status=document.getElementById('status');
function view(is2d){$('#viewer').toggle(!is2d);$('#floorplanner,#tools').toggle(is2d);$('#view2').toggleClass('active',is2d);$('#view3').toggleClass('active',!is2d);if(is2d)app.floorplanner.reset();else app.three.updateWindowSize();}
$('#view2').click(()=>view(true));$('#view3').click(()=>view(false));
$('[data-mode]').click(function(){app.floorplanner.setMode(app.floorplanner.modes[this.dataset.mode]);});
Object.entries(catalogue).forEach(([key,label])=>{const button=document.createElement('button');button.textContent='+ '+label;button.onclick=()=>{view(false);app.model.scene.addItem(1,'warehouse:'+key,{itemName:label,itemType:1,modelUrl:'warehouse:'+key,resizable:true});};document.getElementById('catalog').append(button);});
app.three.itemSelectedCallbacks.add(item=>{selected=item;$('#selection').prop('hidden',false);$('#name').text(item.metadata.itemName);$('#fixed').prop('checked',item.fixed);});
app.three.itemUnselectedCallbacks.add(()=>{selected=null;$('#selection').prop('hidden',true);});
$('#rotate').click(()=>{if(selected&&!selected.fixed){selected.rotation.y+=Math.PI/2;app.model.scene.needsUpdate=true;}});
$('#remove').click(()=>{if(selected){selected.remove();selected=null;$('#selection').prop('hidden',true);}});
$('#fixed').change(function(){if(selected)selected.setFixed(this.checked);});
$('#save').click(()=>{const url=URL.createObjectURL(new Blob([app.model.exportSerialized()],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='warehouse.blueprint3d';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='ส่งออกผังเป็นไฟล์แล้ว';});
$('#load').change(async function(){try{if(!this.files[0])return;const text=await this.files[0].text();const data=JSON.parse(text);if(!data.floorplan||!Array.isArray(data.items)||data.items.some(i=>!catalogue[String(i.model_url).slice(10)]||!String(i.model_url).startsWith('warehouse:')))throw Error('กรุณาใช้ไฟล์จากตัวจัดคลังนี้');app.model.loadSerialized(text);view(false);status.textContent='เปิดผังแล้ว';}catch(e){status.textContent='เปิดไม่ได้: '+e.message;}this.value='';});
const corners={a:{x:-1000,y:-800},b:{x:1000,y:-800},c:{x:1000,y:800},d:{x:-1000,y:800}};
const texture={url:'texture.svg',stretch:true,scale:0};
app.model.loadSerialized(JSON.stringify({floorplan:{corners,walls:[['a','b'],['b','c'],['c','d'],['d','a']].map(([corner1,corner2])=>({corner1,corner2,frontTexture:texture,backTexture:texture})),wallTextures:[],floorTextures:{},newFloorTextures:{}},items:[]}));
})();
