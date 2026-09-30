/* Gate-specific fixed-reader console. Status comes from the reader API; diagnostic
   counts are explicitly scoped to the backend's bounded log, not lifetime
   or daily hardware counters. No synthetic reads or device commands. */
(function (w) {
  'use strict';
  var current = null;
  var icons = {
    radio: '<path d="M12 11v10M8 14a6 6 0 0 1 0-8M16 6a6 6 0 0 1 0 8M5 17a10 10 0 0 1 0-14M19 3a10 10 0 0 1 0 14"/><circle cx="12" cy="9" r="2"/>',
    reader: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 8v8M10 8v8M13 8v8M17 9h.01M17 15h.01"/>',
    log: '<path d="M6 3h9l3 3v15H6zM9 11h6M9 15h6M9 7h2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    settings: '<path d="m10 3-1 3-3 1-3 3 2 2-1 4 3 1 2 4h4l1-3 3-1 3-3-2-2 1-4-3-1-2-4Z"/><circle cx="11.5" cy="12" r="3"/>',
    arrow: '<path d="M3 12h18M15 6l6 6-6 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    chart: '<path d="M4 20V10h3v10M11 20V4h3v16M18 20v-8h3v8"/>',
    tag: '<path d="M3 3h9l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.4"/>',
    box: '<path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9"/>',
    warn: '<path d="m12 3 10 18H2ZM12 9v5M12 17v1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    play: '<path d="m7 4 14 8-14 8Z"/>',
    restart: '<path d="M20 8V3l-4 4a8 8 0 1 0 4 8M20 8h-5"/>',
    cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11ZM12 9v6m-3-3 3 3 3-3"/>',
    trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    guide: '<path d="M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3ZM12 6v16"/>',
    external: '<path d="M14 3h7v7M21 3 11 13M10 4H4v16h16v-6"/>',
    link: '<path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
    save: '<path d="M4 3h13l4 4v14H3V3ZM7 3v6h9V3M7 21v-8h10v8"/>'
  };
  function icon(name) { return '<svg class="fxc-icon" viewBox="0 0 24 24" aria-hidden="true">' + (icons[name] || icons.reader) + '</svg>'; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function count(n) { return Number(n || 0).toLocaleString('en-US'); }
  function el(id) { return document.getElementById(id); }
  function api(path, options) { return w.whRfidApi('/api/rfid/fx9600/' + path, options); }
  function defaultWebhookBaseUrl() {
    try {
      var generated=typeof w.apiWebhookUrl==='function'?w.apiWebhookUrl('/'):w.location.protocol+'//'+w.location.hostname+':4000';
      return new URL(generated,w.location.href).origin;
    } catch (_) { return w.location.protocol+'//'+w.location.hostname+':4000'; }
  }
  function webhookUrl(gate,reader) {
    var path='/api/rfid/readers/'+encodeURIComponent(gate)+'/webhook';
    var base=reader&&reader.webhookBaseUrl?String(reader.webhookBaseUrl).replace(/\/+$/,''):defaultWebhookBaseUrl();
    return base+path;
  }
  function canManage() { return typeof w.hasPerm === 'function' && w.hasPerm('master.manage'); }
  function active(s) { return current === s && s.root && s.root.isConnected && el('modal').classList.contains('show'); }
  function stop() {
    if (!current) return;
    clearTimeout(current.timer);
    if (current.abort) current.abort.abort();
    current = null;
  }
  function warehouse(gate) { return typeof w.gateWh === 'function' && typeof w.whName === 'function' ? w.whName(w.gateWh(gate)) : '—'; }
  function readerStatus(r) {
    var seen = Date.parse(r.lastSeenAt), recent = Number.isFinite(seen) && Date.now() - seen <= Math.max(10, (Number(r.heartbeatIntervalSeconds) || 1) * 3) * 1000;
    return { online: recent, text: !recent ? 'ขาดการเชื่อมต่อ' : r.readingEnabled === false ? 'พักการรับ Tag' : 'พร้อมใช้งาน', detail: !recent ? 'Offline' : r.readingEnabled === false ? 'Online · Paused' : 'Online · Ready' };
  }
  function seenText(ts) {
    var ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return 'ยังไม่เคยได้รับข้อมูล';
    var seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    return new Date(ms).toLocaleTimeString('th-TH', { hour12:false }) + ' · ' + (seconds < 60 ? seconds + ' วินาทีที่แล้ว' : Math.floor(seconds / 60) + ' นาทีที่แล้ว');
  }
  function adminUrl(r) {
    // Use only the configured host, never a URL received in webhook content.
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(r.host || '') ? 'https://' + r.host : '';
  }
  function panel(title, name, body, extra) { return '<section class="fxc-panel"><div class="fxc-panel-head">' + icon(name) + '<h4>' + title + '</h4>' + (extra || '') + '</div>' + body + '</section>'; }
  function action(view, name, title, subtitle, color) {
    return '<button type="button" class="fxc-action" data-fx-view="' + view + '" style="--action-color:' + color + '">' + icon(name) + '<span><b>' + title + '</b><small>' + subtitle + '</small></span></button>';
  }
  function shell(s) {
    var model=s.reader.model||'RFID Reader',name=s.reader.name||s.reader.id;
    var productImage=/fx9600/i.test(model+' '+name)?'<img src="/api/branding/fx9600-reader-image" alt="ภาพเครื่องอ่าน '+esc(model)+'" loading="lazy" onerror="this.hidden=true">':'';
    var navigation = [['overview','chart','ภาพรวม'],['logs','log','Webhook Log'],['settings','settings','ตั้งค่า'],['test','radio','ทดสอบอ่าน Tag'],['firmware','cloud','อัปเดตเฟิร์มแวร์'],['restart','restart','รีสตาร์ท'],['guide','guide','วิธีการตั้งค่า']];
    var quick = '<div class="fxc-actions">' + action('test','play','ทดสอบการอ่าน Tag','ตรวจจับข้อมูลจากเสาอากาศ','#72e44c') + action('restart','restart','รีสตาร์ทอุปกรณ์','เปิดการจัดการบน Zebra','#4299ff') + action('settings','settings','แก้ไขการตั้งค่า','IP, Webhook, Power, เสาฯ','#ffbe44') + action('firmware','cloud','อัปเดตเฟิร์มแวร์','จัดการผ่านหน้าเครื่องอ่าน','#a9bdc7') + action('remove','trash','ลบอุปกรณ์นี้','ยกเลิกการผูกกับ Gate','#ff5656') + '</div>';
    return '<div class="mhead fx-console fx-console-head"><span id="fxConsoleSignal" class="fx-reader-live offline">' + icon('radio') + '</span><div class="fx-console-title"><h3 id="fxConsoleTitle">จัดการ '+esc(name)+'</h3><p>'+esc(model)+' · Gate ' + esc(s.gate) + ' · ' + esc(warehouse(s.gate)) + '</p></div><div class="fx-console-status" id="fxConsoleStatus"></div><button type="button" class="x" data-close aria-label="ปิดหน้าจัดการ RFID Reader">×</button></div>'
      + '<div class="mbody fx-console fx-console-body" id="fxConsoleBody"><div id="fxConsoleError" class="fxc-error" role="status" hidden></div><div id="fxConsoleTop" class="fxc-top">'
      + '<section class="fxc-panel fxc-product">'+productImage+'<div class="fxc-product-name">' + icon('reader') + '<span><b>'+esc(name)+'</b><small>'+esc(model)+'</small></span></div></section>'
      + panel('ข้อมูลอุปกรณ์','reader','<dl class="fxc-facts" id="fxConsoleFacts"></dl>')
      + '<div class="fxc-side">' + panel('เสาอากาศ (Antenna)','radio','<div id="fxConsoleAntennas" class="fxc-antennas"></div>','<button type="button" class="fxc-link" data-fx-view="settings" aria-label="ตั้งค่าเสาอากาศ">'+icon('settings')+'</button>')
      + panel('เส้นทางการทำงาน','link','<div id="fxConsoleFlow"></div>') + '</div></div>'
      + '<nav class="fxc-nav" role="tablist" aria-label="จัดการ RFID Reader">' + navigation.map(function (v) { return '<button type="button" role="tab" data-fx-view="' + v[0] + '" id="fxc-tab-' + v[0] + '" aria-controls="fxc-view-' + v[0] + '" aria-selected="' + (v[0]==='overview') + '" tabindex="' + (v[0]==='overview' ? '0' : '-1') + '">' + icon(v[1]) + '<span>' + v[2] + '</span></button>'; }).join('') + '</nav>'
      + '<div id="fxc-view-overview" role="tabpanel" aria-labelledby="fxc-tab-overview" class="fxc-bottom">'
      + panel('สถิติการอ่าน Tag','chart','<div id="fxConsoleStats" class="fxc-stats"></div><div id="fxConsoleChart"></div><p class="fxc-caption">นับจาก Log ที่เก็บไว้ล่าสุดไม่เกิน 200 รายการ ไม่ใช่ยอดสะสมทั้งวัน</p>','<select class="fxc-select" id="fxConsoleRange" aria-label="ช่วงเวลาสถิติ"><option value="today">วันนี้</option><option value="hour">1 ชั่วโมง</option><option value="all">Log ทั้งหมด</option></select>')
      + panel('Log ล่าสุด','log','<div id="fxConsoleRecent"></div>','<button type="button" class="fxc-link" data-fx-view="logs">ดูทั้งหมด ' + icon('chevron') + '</button>')
      + panel('การดำเนินการด่วน','pulse',quick) + '</div>'
      + navigation.slice(1).map(function (v) { return '<section class="fxc-panel" id="fxc-view-' + v[0] + '" role="tabpanel" aria-labelledby="fxc-tab-' + v[0] + '" hidden></section>'; }).join('')
      + '<section class="fxc-panel" id="fxc-view-remove" hidden></section></div>'
      + '<div class="mfoot fx-console fx-console-foot"><button type="button" class="fxc-guide-link" id="fxConsoleGuide">' + icon('guide') + 'คู่มือการเชื่อมต่อ Reader ' + icon('external') + '</button><button type="button" class="btn gray" data-close>ปิด</button></div>';
  }
  function error(s, message) {
    if (!active(s)) return;
    var node = el('fxConsoleError');node.textContent = message || '';node.hidden = !message;
  }
  function syncLocal(response) {
    // Mutation routes return { reader: Reader }; unwrap consistently so a
    // settings autosave cannot replace the live Reader with its response body.
    var r=response&&response.reader?response.reader:response;
    var readers = (w.whGateRfidReaders || []).filter(function (x) { return x.id === r.id || Number(x.gateNo) !== Number(r.gateNo); }), local = readers.find(function (x) { return x.id === r.id; });
    w.whGateRfidReaders=readers;
    if (local) Object.assign(local, r); else readers.push(r);
    return r;
  }
  function refresh(s) {
    if (!active(s) || s.busy) return;
    s.busy = true;s.abort = new AbortController();
    var revision=s.revision;
    var opts = { signal:s.abort.signal, cache:'no-store' };
    Promise.allSettled([api('readers', opts), api('debug-log', opts)]).then(function (results) {
      if (!active(s)) return;
      var problems = [];
      if (results[0].status === 'fulfilled' && !s.saving && revision===s.revision) {
        var reader = (results[0].value.readers || []).find(function (r) { return r.id === s.reader.id && Number(r.gateNo) === s.gate; });
        if (reader) { s.reader = reader;s.missing = false;syncLocal(reader); }
        else { s.missing = true;problems.push('ไม่พบการผูกเครื่องนี้กับ Gate แล้ว กรุณาปิดและเลือกอุปกรณ์ใหม่'); }
      } else if(results[0].status !== 'fulfilled') problems.push('โหลดสถานะเครื่องไม่สำเร็จ กำลังลองเชื่อมต่อใหม่');
      s.statusError = results[0].status !== 'fulfilled';
      if (results[1].status === 'fulfilled') {
        s.logs = (results[1].value.entries || []).filter(function (x) { return Number(x.gate) === s.gate && (!x.device || String(x.device) === String(s.reader.id)); }).sort(function (a,b) { return Date.parse(b.ts) - Date.parse(a.ts); });
        s.logError = false;s.logsLoaded = true;
      } else { s.logError = true;problems.push('โหลด Log ไม่สำเร็จ ข้อมูล Log ที่แสดงอาจไม่ใช่ล่าสุด'); }
      error(s, problems.join(' · '));renderLive(s);
    }).finally(function () {
      s.busy = false;
      if (active(s)) s.timer = setTimeout(function () { refresh(s); }, 2000);
    });
  }
  function dataRows(s) {
    var now = Date.now(), start = s.range === 'hour' ? now - 3600000 : s.range === 'today' ? new Date().setHours(0,0,0,0) : -Infinity;
    return s.logs.filter(function (e) { var ms = Date.parse(e.ts);return ms >= start && ms <= now; });
  }
  function statCounts(rows) {
    return rows.reduce(function (a,e) { a.read += (e.epcs || []).length;a.unknown += (e.unknown || []).length;a.repeat += (e.repeats || []).length;a.error += e.parseError ? 1 : 0;return a; }, {read:0,unknown:0,repeat:0,error:0});
  }
  function chart(rows) {
    var bins = Array(24).fill(0);
    rows.forEach(function (e) { var h = new Date(e.ts).getHours();if(Number.isFinite(h)) bins[h] += (e.epcs || []).length; });
    var max = Math.max(1, Math.ceil(Math.max.apply(null,bins) / 4) * 4), svg = '<svg viewBox="0 0 340 145" class="fxc-chart" role="img" aria-label="จำนวนการอ่าน Tag ตามชั่วโมงจาก Log ที่เก็บไว้">';
    for (var i=0;i<5;i++) { var y = 115-i*24;svg += '<line x1="28" y1="'+y+'" x2="334" y2="'+y+'"/><text x="22" y="'+(y+3)+'" text-anchor="end">'+count(Math.round(max*i/4))+'</text>'; }
    bins.forEach(function (n,h) { var height = n/max*94;svg += '<rect x="'+(33+h*12.3)+'" y="'+(115-height)+'" width="7" height="'+height+'" rx="1.5"><title>'+h+':00 · '+count(n)+' ครั้ง</title></rect>'; });
    [0,6,12,18,24].forEach(function (h) { svg += '<text x="'+(29+h*12.65)+'" y="134" text-anchor="middle">'+String(h).padStart(2,'0')+':00</text>'; });
    return svg + '</svg>';
  }
  function logType(e) { return e.parseError ? 'ข้อมูลผิดรูปแบบ' : (e.epcs || []).length || (e.decoded || []).length ? 'Tag Read' : 'Heartbeat'; }
  function logRows(rows, loaded) {
    if (!rows.length) return '<div class="fxc-state-note">' + (loaded ? 'ยังไม่มี Log ของ Gate นี้ในช่วงที่เลือก' : 'กำลังโหลด Log…') + '</div>';
    return '<div class="fxc-log-head"><span>เวลา</span><span>ประเภท</span><span>รายละเอียด</span></div>' + rows.map(function(e) {
      var desc = e.parseError || (e.decoded || e.epcs || []).join(', ') || '—';
      return '<div class="fxc-log-row"><span><i class="fx-dot '+(!e.parseError?'is-online':'')+'"></i><time>'+esc(new Date(e.ts).toLocaleTimeString('th-TH',{hour12:false}))+'</time></span><span>'+esc(logType(e))+'</span><span>'+esc(desc)+((e.repeats||[]).length?'<small>อ่านซ้ำ '+e.repeats.length+' Tag</small>':'')+'</span></div>';
    }).join('');
  }
  function antennaEvidence(s, port) {
    var countReads = 0, last = null;
    s.logs.forEach(function (entry) {
      // Raw logs may contain several antenna ports. Attribute only individual
      // reads with an explicit matching port; never copy total counts to each.
      try {
        var raw = JSON.parse(entry.rawBody), reads = Array.isArray(raw) ? raw : Array.isArray(raw.tagReports) ? raw.tagReports : [raw.data || raw];
        reads.forEach(function (item) {
          var r=item,depth=0;while(r && r.data && depth++<4) r=r.data;
          if (!r) return;
          var p = r.antennaPort ?? r.antenna_port ?? r.antenna ?? r.antennaId ?? r.antennaID ?? r.port;
          if (Number(p) === port && (r.idHex || r.epc || r.EPC || r.tagId || r.id)) { countReads++;if(!last || Date.parse(entry.ts)>Date.parse(last))last=entry.ts; }
        });
      } catch (_) { /* Truncated/invalid raw bodies cannot establish antenna counts. */ }
    });
    return {count:countReads,last:last};
  }
  function renderLive(s) {
    if (!active(s)) return;
    var r=s.reader,status=readerStatus(r),on=r.readingEnabled!==false;
    if(s.statusError || s.missing)status={online:false,text:'ตรวจสอบการเชื่อมต่อ',detail:'สถานะยังไม่ยืนยัน'};
    var statusNode=el('fxConsoleStatus');statusNode.classList.toggle('is-offline',!status.online);
    statusNode.innerHTML='<i class="fx-dot '+(status.online?'is-online':'')+'"></i><span><b>'+esc(status.text)+'</b><small>'+esc(status.detail)+'</small></span>';
    el('fxConsoleSignal').className='fx-reader-live '+(status.online?'online':'offline');
    var toggle='<button type="button" class="fxc-switch" role="switch" aria-label="การอ่าน Tag" aria-checked="'+on+'" data-fx-action="toggle" '+(!canManage()||s.saving||s.missing||s.statusError?'disabled':'')+' title="เปิดหรือพักการรับ Tag เข้าระบบ"><span class="fxc-switch-track" aria-hidden="true"></span><span>'+(on?'เปิดใช้งาน':'พักรับข้อมูล')+'</span></button>';
    var rows=[['reader','ชื่ออุปกรณ์',esc(r.name||r.id)],['reader','รุ่น',esc(r.model||'RFID Reader')],['reader','Reader ID',esc(r.id)],['globe','IP / Host',esc(r.host||'—')],['database','DB Gate','Gate '+esc(s.gate)+' · '+esc(warehouse(s.gate))],['pulse','สถานะ','<i class="fx-dot '+(status.online?'is-online':'')+'"></i> '+esc(status.detail)],['radio','การอ่าน Tag',toggle],['clock','เห็นล่าสุด',esc(seenText(r.lastSeenAt))],['radio','จำนวนเสาอากาศ',esc(r.antennaCount??'—')],['pulse','Heartbeat ที่ระบบคาดหวัง',esc(r.heartbeatIntervalSeconds||1)+' วินาที']];
    el('fxConsoleFacts').innerHTML=rows.map(function(row){return '<div class="fxc-fact">'+icon(row[0])+'<dt>'+row[1]+'</dt><dd>'+row[2]+'</dd></div>';}).join('');
    var ports=Array.from({length:Math.min(64,Math.max(0,Number(r.antennaCount)||0))},function(_,i){return i+1;});
    el('fxConsoleAntennas').innerHTML=ports.map(function(port){
      var evidence=antennaEvidence(s,port),seen=evidence.last||(r.activeAntennas||[]).map(Number).includes(port)&&r.lastTagSeenAt;
      var reading=status.online&&on&&seen&&Date.now()-Date.parse(seen)<15000;
      var link=r.antennaStatuses&&r.antennaStatuses[String(port)],age=link&&Date.now()-Date.parse(link.updatedAt),tagReadStale=link&&link.source==='tag_read'&&(!Number.isFinite(age)||age<0||age>30000),known=link&&typeof link.connected==='boolean'&&!tagReadStale;
      var connected=!!(known&&link.connected);
      var linkText=!known?(tagReadStale?'ไม่พบ Tag ล่าสุด':'ไม่ทราบสถานะการต่อ'):connected?(link.source==='tag_read'?'Online · อ่าน Tag ได้':'ต่อเสาแล้ว'):'ไม่ได้ต่อเสา';
      var linkDetail=tagReadStale?'ไม่มีการอ่าน Tag พอร์ตนี้ใน 30 วินาทีล่าสุด · ยังยืนยันการต่อสายไม่ได้':(reading?'พบ Tag ล่าสุด':'Log อ่าน Tag '+count(evidence.count)+' ครั้ง');
      return '<div class="fxc-antenna"><span class="fxc-antenna-copy"><b>Antenna '+port+'</b><small>สถานะจาก Event หรือการอ่าน Tag จริง</small></span><span class="fxc-antenna-state"><i class="fx-dot '+(known&&connected?'is-online':'')+'"></i> '+linkText+'<small>'+linkDetail+(known&&link&&link.updatedAt?' · ตรวจ '+esc(seenText(link.updatedAt)):'')+'</small></span></div>';
    }).join('')||'<p class="fxc-caption">ยังไม่ได้กำหนดจำนวนเสาอากาศ</p>';
    var flowNode=function(i,title,sub){return '<div class="fxc-flow-node">'+icon(i)+'<b>'+title+'</b><small>'+sub+'</small></div>';};
    el('fxConsoleFlow').innerHTML='<div class="fxc-flow '+(status.online&&on?'is-live':'')+'">'+flowNode('radio','Antenna',ports.length+' พอร์ต')+icon('arrow')+flowNode('reader',esc(r.model||'RFID Reader'),esc(r.name||r.id))+icon('arrow')+flowNode('database','Backend',s.statusError?'ไม่ตอบสนอง':'รับ Webhook')+'</div><div class="fxc-flow-status">'+(status.online?'<i class="fx-dot is-online"></i> ':'')+esc(status.detail)+'</div>';
    var filtered=dataRows(s),stats=statCounts(filtered);
    el('fxConsoleStats').innerHTML=[['read','tag','อ่าน Tag','#8ce860'],['unknown','box','ไม่รู้จัก','#66b5ff'],['repeat','warn','อ่านซ้ำ','#ffc056'],['error','close','ผิดรูปแบบ','#c1cbd4']].map(function(x){return '<div class="fxc-stat" style="--stat-color:'+x[3]+'"><b>'+icon(x[1])+(s.logsLoaded?count(stats[x[0]]):'—')+'</b><small>'+x[2]+'</small></div>';}).join('');
    el('fxConsoleChart').innerHTML=chart(filtered);
    el('fxConsoleRecent').innerHTML=logRows(s.logs.slice(0,8),s.logsLoaded);
    if(s.view==='logs')renderLogs(s);
    if(s.view==='test')renderTest(s);
  }
  function renderLogs(s) {
    var host=el('fxc-view-logs');
    if(!host.querySelector('#fxConsoleLogEntries'))host.innerHTML='<div class="fxc-panel-head">'+icon('log')+'<h4>Webhook Log · Gate '+esc(s.gate)+'</h4><span class="fxc-caption">อัปเดตทุก 2 วินาที</span></div><p class="fxc-caption">แสดงข้อมูลที่ Backend เก็บไว้ล่าสุดไม่เกิน 200 รายการ เลือกแถวเพื่อดูข้อมูลดิบ</p><div id="fxConsoleLogEntries"></div>';
    var entries=el('fxConsoleLogEntries'), signature=JSON.stringify(s.logs);
    if(s.logSignature===signature && entries.childNodes.length)return;
    s.logSignature=signature;
    var opened=Array.from(entries.querySelectorAll('details[open]')).map(function(d){return d.dataset.key;});
    entries.innerHTML=s.logs.length?s.logs.map(function(e,i){var key=e.ts+'|'+(e.rawBody||'');return '<details class="fxc-log-detail" data-key="'+esc(key)+'" '+(opened.includes(key)?'open':'')+'><summary>'+esc(new Date(e.ts).toLocaleString('th-TH'))+' · '+esc(logType(e))+' · '+esc((e.decoded||[]).join(', ')||'ไม่มี Tag')+'</summary><p class="fxc-caption">รับเข้า/ส่งออก: '+esc((e.received||[]).join(', ')||'—')+' · ไม่รู้จัก: '+esc((e.unknown||[]).join(', ')||'—')+' · อ่านซ้ำ: '+esc((e.repeats||[]).join(', ')||'—')+'</p><pre class="fxc-pre">'+esc(e.rawBody||'ไม่มีข้อมูลดิบ')+'</pre></details>';}).join(''):'<div class="fxc-state-note">'+(s.logsLoaded?'ยังไม่มี Log ของ Gate นี้':'กำลังโหลด Log…')+'</div>';
  }
  function field(name,label,type,value,attrs) {return '<label class="fxc-field">'+label+'<input name="'+name+'" type="'+type+'" value="'+esc(value)+'" '+(attrs||'')+'></label>';}
  function renderSettings(s) {
    var r=s.reader;
    var host=el('fxc-view-settings');
    host.innerHTML='<div class="fxc-panel-head">'+icon('settings')+'<h4>ตั้งค่า RFID Reader · Gate '+s.gate+'</h4></div><p class="fxc-notice">ลงทะเบียนรุ่นที่ติดตั้งได้ที่นี่ ส่วนการตั้งค่าเครือข่ายและปลายทาง Webhook ต้องตั้งบนหน้าเครื่องอ่านโดยตรง ระบบไม่ส่งคำสั่งจัดการฮาร์ดแวร์จากหน้านี้</p><p class="fxc-notice">เมื่อติดตั้งเครื่องใหม่ เปลี่ยน Reader ID เพื่อให้ระบบยุติทะเบียนเครื่องเดิมและเริ่มสถานะเสาอากาศชุดใหม่ ประวัติ Webhook ของเครื่องเก่ายังคงตรวจสอบได้</p>'
      +(!canManage()?'<p class="fxc-notice">บัญชีนี้ดูข้อมูลได้ การบันทึกต้องใช้สิทธิ์จัดการข้อมูลหลัก</p>':'')
      +'<form id="fxConsoleSettings"><fieldset '+(!canManage()||s.missing?'disabled':'')+' style="border:0;padding:0;margin:0;min-width:0;"><div class="fxc-form">'
      +field('name','ชื่ออุปกรณ์','text',r.name||r.id,'required maxlength="100"')+field('readerId','Reader ID (เปลี่ยนค่าเพื่อสลับเครื่อง)','text',r.id,'required maxlength="120"')
      // Avoid a v-mode-invalid pattern: hyphens in character classes must be
      // escaped under modern HTML pattern semantics. The server validates
      // length and stores hostnames/IPs, so don't block valid IPv4/IPv6 here.
      +field('model','รุ่นอุปกรณ์','text',r.model||'','required maxlength="80" placeholder="เช่น FX9600 หรือ FXR90"')+field('host','IP / Host','text',r.host,'required maxlength="255"')+field('gateNo','Gate ที่เชื่อมต่อ','number',s.gate,'readonly')
      +'<label class="fxc-field">Webhook IP / Host:Port <input name="webhookBaseUrl" type="url" value="'+esc(r.webhookBaseUrl||defaultWebhookBaseUrl())+'" required placeholder="http://192.168.1.2:4000"></label>'
      +'<label class="fxc-field">Webhook URL (Path ถูกกำหนดตาม Gate) <input id="fxConsoleWebhookPreview" type="url" value="'+esc(webhookUrl(s.gate,r))+'" readonly aria-label="Webhook URL สำหรับ Gate '+esc(s.gate)+'"></label>'
      +field('heartbeatIntervalSeconds','Heartbeat ที่คาดหวังสำหรับสถานะระบบ (วินาที)','number',r.heartbeatIntervalSeconds||1,'min="1" max="3600" step="1" required')
      +field('antennaCount','จำนวนเสาอากาศของรุ่นนี้','number',r.antennaCount||2,'min="1" max="64" step="1" required')
      +'</div>'
      +'<div class="fxc-form-actions"><span class="fxc-caption" id="fxConsoleSaveStatus" role="status">บันทึกเมื่อกำหนดชื่อ, Reader ID, รุ่น และจำนวนเสาอากาศครบแล้ว</span><button type="submit" class="btn accent sm" '+(!canManage()||s.missing?'disabled':'')+'>บันทึก / สลับเครื่องอ่าน</button></div></fieldset></form>';
  }
  function flushQueuedSettings(s) {
    if(!s.saveQueued||!active(s))return;
    var form=el('fxConsoleSettings'),field=s.saveQueuedField;
    s.saveQueued=false;s.saveQueuedField=null;
    if(form&&field&&field.isConnected)saveSettings(s,form,field);
  }
  async function saveSettings(s,form) {
    if(!canManage()||s.missing||!form.reportValidity())return;
    var status=el('fxConsoleSaveStatus');
    if(s.saving)return;
    var data=new FormData(form),readerId=String(data.get('readerId')).trim(),body={name:String(data.get('name')).trim(),model:String(data.get('model')).trim(),host:String(data.get('host')).trim(),webhookBaseUrl:String(data.get('webhookBaseUrl')).trim().replace(/\/+$/,''),gateNo:s.gate,antennaCount:Number(data.get('antennaCount')),heartbeatIntervalSeconds:Number(data.get('heartbeatIntervalSeconds'))};
    s.saving=true;s.revision++;if(status)status.textContent='กำลังบันทึก…';
    try {
      var oldReader=s.reader;
      var result=syncLocal(await api('readers/'+encodeURIComponent(readerId),{method:'PUT',body:JSON.stringify(body)}));
      var identityChanged=oldReader.id!==result.id||oldReader.model!==result.model||oldReader.name!==result.name;
      if(active(s)){
        s.reader=result;error(s,'');
        if(identityChanged){w.closeModal();w.toast('บันทึกเครื่องอ่านแล้ว','ข้อมูลปัจจุบันอัปเดตและประวัติยังแยกตาม Reader ID','ok');if(typeof w.loadRfidGateBindings==='function')w.loadRfidGateBindings();}
        else{if(status)status.textContent='บันทึกแล้ว';renderLive(s);}
      }
    } catch(e) {if(active(s)&&status)status.textContent='บันทึกไม่สำเร็จ: '+e.message;}
    finally {
      s.saving=false;
    }
  }
  async function toggle(s) {
    if(s.saving||s.missing||s.statusError||!canManage())return;
    s.saving=true;s.revision++;renderLive(s);
    try {
      var result=syncLocal(await api('readers/'+encodeURIComponent(s.reader.id)+'/reading',{method:'POST',body:JSON.stringify({enabled:s.reader.readingEnabled===false})}));
      // Mutation results, not the intended state, are authoritative.
      if(active(s)){s.reader=Object.assign({},s.reader,result);error(s,'');w.toast(result.readingEnabled?'เปิดการรับ Tag แล้ว':'พักการรับ Tag แล้ว',s.reader.name,'ok');}
    }catch(e){error(s,'เปลี่ยนสถานะไม่สำเร็จ: '+e.message);}
    finally{s.saving=false;if(active(s))renderLive(s);flushQueuedSettings(s);}
  }
  function renderTest(s) {
    var host=el('fxc-view-test');
    if(!host.querySelector('#fxConsoleTestResult'))host.innerHTML='<div class="fxc-panel-head">'+icon('radio')+'<h4>ทดสอบการอ่าน Tag · Gate '+s.gate+'</h4></div><div class="fxc-notice">นำ Tag ผ่านเสาอากาศ แล้วเริ่มตรวจจับข้อมูลจริง 30 วินาที การรับเข้า/ส่งออกยังทำงานตามการตั้งค่าประตูปกติ จึงควรใช้กล่องที่ต้องการทำรายการจริง</div><button type="button" class="btn accent sm" data-fx-action="test">'+icon('play')+' เริ่มตรวจจับ 30 วินาที</button><div id="fxConsoleTestResult" class="fxc-state-note" aria-live="polite"></div>';
    var button=host.querySelector('[data-fx-action=test]'),running=s.testStart&&Date.now()<s.testStart+30000;
    button.disabled=!!running||s.reader.readingEnabled===false||!readerStatus(s.reader).online||s.statusError||s.missing;
    var result=el('fxConsoleTestResult');
    if(!s.testStart){result.textContent=button.disabled?'เครื่องต้อง Online และเปิดรับ Tag ก่อนเริ่มตรวจจับ':'พร้อมตรวจจับ Tag จาก Gate นี้';return;}
    var rows=s.logs.filter(function(e){var t=Date.parse(e.ts);return t>=s.testStart&&t<=s.testStart+30000&&(e.epcs||[]).length;}),total=statCounts(rows).read;
    result.innerHTML='<div class="fxc-test-live">'+icon('radio')+'<span><b>'+(running?'กำลังตรวจจับ · เหลือ '+Math.max(0,Math.ceil((s.testStart+30000-Date.now())/1000))+' วินาที':'สิ้นสุดการตรวจจับ')+'</b><br>พบการอ่าน '+count(total)+' ครั้ง'+(s.logError?' · เชื่อมต่อ Log ไม่สำเร็จ ผลอาจไม่ครบ':'')+'</span></div>'+logRows(rows.slice(0,12),true);
  }
  function renderDeviceTask(s,kind) {
    var restart=kind==='restart',url=adminUrl(s.reader),host=el('fxc-view-'+kind);
    host.innerHTML='<div class="fxc-panel-head">'+icon(restart?'restart':'cloud')+'<h4>'+(restart?'รีสตาร์ทอุปกรณ์':'อัปเดตเฟิร์มแวร์')+' · '+esc(s.reader.name)+'</h4></div><div class="fxc-notice">เครื่องนี้เชื่อมต่อแบบส่ง Webhook เข้าระบบ การ'+(restart?'รีสตาร์ท':'ติดตั้งเฟิร์มแวร์')+'ต้องดำเนินการในหน้า Zebra ของเครื่อง '+esc(s.reader.host)+' การกดเปิดด้านล่างจะยังไม่สั่ง'+(restart?'รีสตาร์ท':'ติดตั้งเฟิร์มแวร์')+'ทันที</div>'
      +'<ol class="fxc-steps"><li>เปิดหน้าเครื่องอ่านและเข้าสู่ระบบด้วยบัญชีของ Zebra</li><li>'+(restart?'ตรวจว่าไม่มีรถหรือกล่องกำลังผ่านประตู แล้วใช้คำสั่งรีสตาร์ทในหน้าเครื่อง':'ตรวจรุ่นเครื่องและเฟิร์มแวร์ปัจจุบัน จากนั้นใช้ไฟล์เฟิร์มแวร์ที่ตรงรุ่นในหน้าอัปเดตของเครื่อง')+'</li><li>กลับมาที่ภาพรวมนี้เพื่อตรวจ Heartbeat และสถานะ Online</li></ol>'
      +(url?'<a class="btn ghost sm" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+icon('external')+' เปิด Zebra Console · '+esc(s.reader.host)+'</a>':'<p>กรุณาตั้งค่า IP / Host ที่ถูกต้องก่อน</p>');
  }
  function renderGuide(s) {
    var r=s.reader;
    el('fxc-view-guide').innerHTML='<div class="fxc-panel-head">'+icon('guide')+'<h4>การเชื่อมต่อ '+esc(r.model||'RFID Reader')+' · Gate '+s.gate+'</h4></div><p class="fxc-notice">ตั้ง URL นี้เป็นปลายทาง Webhook บนเครื่องอ่าน ระบบเปิดรับ HTTP POST จากอุปกรณ์ในเครือข่ายที่กำหนด โดยยังคงรองรับ URL FX9600 แบบเดิมสำหรับเครื่องที่ติดตั้งอยู่แล้ว</p><div class="fxc-guide-grid">'
      +[['เครื่องอ่าน',r.name||r.id],['รุ่น',r.model||'—'],['Reader ID',r.id],['IP / Host',r.host||'—'],['Gate','Gate '+s.gate],['Webhook URL',webhookUrl(s.gate,r)],['Heartbeat ที่ระบบใช้ตัดสิน Online', (r.heartbeatIntervalSeconds||1)+' วินาที (เป็นค่าในระบบเท่านั้น)']].map(function(row){return '<div class="fxc-guide-value"><small>'+esc(row[0])+'</small><b>'+esc(row[1])+'</b></div>';}).join('')+'</div><div class="fxc-form-actions">'+(adminUrl(r)?'<a class="btn ghost sm" href="'+esc(adminUrl(r))+'" target="_blank" rel="noopener noreferrer">'+icon('external')+' เปิดหน้าเครื่องอ่าน</a>':'')+'</div>';
  }
  function renderRemove(s) {
    el('fxc-view-remove').innerHTML='<div class="fxc-panel-head">'+icon('trash')+'<h4>ลบการผูกอุปกรณ์</h4></div><p class="fxc-notice">ยกเลิกการผูก '+esc(s.reader.name||s.reader.id)+' กับ Gate '+s.gate+' ใน '+esc(warehouse(s.gate))+' การตั้งค่าบนเครื่อง Zebra และประวัติกล่องยังคงอยู่</p><div class="fxc-form-actions"><button type="button" class="btn ghost sm" data-fx-view="overview">ยกเลิก</button><button type="button" class="btn sm" style="color:var(--neg);border:1px solid var(--neg);" data-fx-action="remove" '+(!canManage()?'disabled':'')+'>ยืนยันยกเลิกการผูก '+esc(s.reader.name||s.reader.id)+'</button></div>';
  }
  function view(s,name) {
    if(!active(s)||!el('fxc-view-'+name))return;
    s.view=name;
    s.root.querySelectorAll('[role=tabpanel],#fxc-view-remove').forEach(function(p){p.hidden=p.id!=='fxc-view-'+name;});
    el('fxConsoleTop').hidden=name!=='overview';
    s.root.querySelectorAll('[role=tab]').forEach(function(tab){var selected=tab.dataset.fxView===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
    if(name==='settings'&&!el('fxConsoleSettings'))renderSettings(s);
    if(name==='logs')renderLogs(s);
    if(name==='test')renderTest(s);
    if(name==='firmware'||name==='restart')renderDeviceTask(s,name);
    if(name==='guide')renderGuide(s);
    if(name==='remove')renderRemove(s);
    s.root.scrollTop=0;
  }
  function bind(s) {
    s.root.addEventListener('click',function(event){
      var target=event.target.closest('[data-fx-view],[data-fx-action]');if(!target)return;
      if(target.dataset.fxView){view(s,target.dataset.fxView);if(target.dataset.fxPort){var sel=s.root.querySelector('[data-map-port="'+Number(target.dataset.fxPort)+'"] select');if(sel)sel.focus();}return;}
      var act=target.dataset.fxAction;
      if(act==='toggle')toggle(s);
      if(act==='test'){s.testStart=Date.now();renderTest(s);}
      if(act==='remove'&&canManage()&&!s.saving){s.saving=true;target.disabled=true;api('readers/'+encodeURIComponent(s.reader.id),{method:'DELETE'}).then(function(){w.whGateRfidReaders=(w.whGateRfidReaders||[]).filter(function(r){return r.id!==s.reader.id;});if(active(s))w.closeModal();w.toast('ยกเลิกการผูกอุปกรณ์แล้ว',s.reader.name,'ok');if(typeof w.loadRfidGateBindings==='function')w.loadRfidGateBindings().then(function(){if(typeof w.renderOverview==='function')w.renderOverview();}).catch(function(){});}).catch(function(e){error(s,'ยกเลิกการผูกไม่สำเร็จ: '+e.message);target.disabled=false;}).finally(function(){s.saving=false;});}
    });
    s.root.addEventListener('change',function(event){if(event.target.id==='fxConsoleRange'){s.range=event.target.value;renderLive(s);return;}if(event.target.name==='webhookBaseUrl'){var preview=el('fxConsoleWebhookPreview');if(preview)preview.value=webhookUrl(s.gate,{webhookBaseUrl:event.target.value});}});
    s.root.addEventListener('submit',function(event){if(event.target.id==='fxConsoleSettings'){event.preventDefault();saveSettings(s,event.target);}});
    s.root.addEventListener('keydown',function(event){var tab=event.target.closest('[role=tab]');if(!tab||!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();var tabs=Array.from(s.root.querySelectorAll('[role=tab]')),i=tabs.indexOf(tab);i=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;view(s,tabs[i].dataset.fxView);tabs[i].focus();});
    el('fxConsoleGuide').onclick=function(){view(s,'guide');};
  }
  async function open(gate) {
    if(typeof w.rfidGateEnabled==='function'&&!w.rfidGateEnabled())return;
    var readers=(w.whGateRfidReaders||[]).filter(function(r){return r&&r.gateNo!=null;});
    if(gate==null&&readers.length===1)gate=readers[0].gateNo;
    if(gate==null){
      w.openModal('<div class="mhead"><h3>เลือก RFID Reader</h3><button class="x" data-close>×</button></div><div class="mbody" id="fxConsolePicker">'+(readers.length?readers.map(function(r){return '<button type="button" class="btn ghost" style="width:100%;margin-bottom:8px;" data-reader-gate="'+Number(r.gateNo)+'">'+esc(r.name||r.id)+' · '+esc(r.model||'RFID Reader')+' · Gate '+Number(r.gateNo)+'</button>';}).join(''):'ยังไม่มี Reader ที่ผูกกับ Gate')+'</div>');
      el('fxConsolePicker').addEventListener('click',function(e){var b=e.target.closest('[data-reader-gate]');if(b)open(Number(b.dataset.readerGate));});return;
    }
    var reader=readers.find(function(r){return Number(r.gateNo)===Number(gate);});
    if(!reader){w.toast('ไม่พบ RFID Reader ของ Gate นี้','กรุณารีเฟรชการเชื่อมต่ออุปกรณ์','err');return;}
    stop();if(typeof w.stopRfidGateLogRefresh==='function'){w.activeRfidGateLog=null;w.stopRfidGateLogRefresh();}
    var s={gate:Number(gate),reader:Object.assign({},reader),logs:[],logsLoaded:false,range:'today',view:'overview',saving:false,busy:false,revision:0};
    w.openModal(shell(s));s.root=el('fxConsoleBody');current=s;bind(s);renderLive(s);refresh(s);
  }
  w.FxConsole={open:open,stop:stop};
})(window);
