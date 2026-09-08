'use strict';
(() => {
 const tools=document.getElementById('tools');document.getElementById('floorplanner').append(tools);
 const done=document.createElement('button');done.id='done';done.textContent='เสร็จแล้ว »';tools.append(done);
 const nav=document.createElement('div');nav.id='nav';
 [['แก้ไขผัง 2D','view2'],['จัดวาง 3D','view3']].forEach(([label,id])=>{const b=document.createElement('button');b.textContent=label;b.onclick=()=>document.getElementById(id).click();nav.append(b);});
 const add=document.createElement('button');add.id='add-tab';add.textContent='เพิ่มอุปกรณ์';nav.append(add);document.querySelector('aside').prepend(nav);
 const heading=document.createElement('h3');heading.textContent='แร็กจากระบบ';
 const refresh=document.createElement('button');refresh.id='refresh-racks';refresh.textContent='โหลดรายการแร็ก';
 const racks=document.createElement('div');racks.id='db-racks';nav.after(heading,refresh,racks);
 const camera=document.createElement('div');camera.id='camera';[['zoom-in','＋'],['home-view','จัดมุมกล้อง'],['zoom-out','−']].forEach(([id,text])=>{const b=document.createElement('button');b.id=id;b.textContent=text;camera.append(b);});document.body.append(camera);
 const dims=document.createElement('p');dims.id='dimensions';document.getElementById('selection').append(dims);
 const label=document.createElement('label');label.textContent='มุมหมุน (องศา) ';const angle=document.createElement('input');angle.id='angle';angle.type='number';angle.step='15';label.append(angle);document.getElementById('selection').append(label);
 const credit=document.createElement('a');credit.href='/models/ATTRIBUTION.md';credit.textContent='เครดิตโมเดล';document.querySelector('aside').append(credit);
})();
