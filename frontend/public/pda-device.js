/* What the PDA detail window and the connect QR show. Pure data: no DOM. */
(function () {
  function ago(iso, now) {
    var s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (isNaN(s)) return '—';
    if (s < 60) return s + ' วินาทีที่แล้ว';
    if (s < 3600) return Math.floor(s / 60) + ' นาทีที่แล้ว';
    if (s < 86400) return Math.floor(s / 3600) + ' ชั่วโมงที่แล้ว';
    return Math.floor(s / 86400) + ' วันที่แล้ว';
  }
  function flag(v) { return typeof v === 'boolean' ? v : null; }

  /** A device as GET /api/devices returns it → the window's texts (unescaped). */
  function view(d, ctx) {
    var online = d.online === true;
    var state = d.state === 'sleeping' || d.state === 'online' ? d.state : (online ? 'online' : 'offline');
    var post = [];
    if (d.warehouse) {
      var wh = (ctx && ctx.warehouseName) || d.warehouse;
      post.push(wh.indexOf('คลัง') === 0 ? wh : 'คลัง ' + wh);
    }
    if (d.gate) post.push('ประตู ' + d.gate);
    var who = d.employeeName || d.employeeId;
    return {
      title: d.name || 'PDA Scanner',
      online: online,
      state: state,
      user: !who ? 'ยังไม่มีผู้เข้างาน' : d.employeeName && d.employeeId ? d.employeeName + ' (' + d.employeeId + ')' : who,
      post: post.join(' · ') || '—',
      seen: ago(d.lastSeenAt, (ctx && ctx.now) || Date.now()),
      model: d.model ? d.model.toUpperCase() : '—',
      ip: d.ipAddress || '—',
      rfid: flag(d.hasIntegratedRfid),
      zebra: flag(d.usesZebraSdk),
      hint: state === 'online' ? '' : state === 'sleeping' ? 'หน้าจอเครื่องดับหรือถูกล็อก กดปุ่มเปิดจอเพื่อกลับมาใช้งาน' : 'เปิดแอปบนเครื่องค้างไว้ และให้เครื่องอยู่ Wi-Fi เดียวกับเซิร์ฟเวอร์',
    };
  }

  function parse(text) {
    var t = String(text || '').trim();
    if (!t || /\s/.test(t)) return null;
    var hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
    if (hasScheme && !/^https?:\/\//i.test(t)) return null;
    try { return { url: new URL(hasScheme ? t : 'http://' + t), typed: t.replace(/^[a-z]+:\/\//i, ''), hasScheme: hasScheme }; } catch (e) { return null; }
  }
  function isLocalHost(host) { return host === 'localhost' || /\.localhost$/.test(host) || /^127\./.test(host) || host === '[::1]' || host === '0.0.0.0'; }
  function isLocalUrl(text) { var p = parse(text); return !!p && isLocalHost(p.url.hostname); }

  /** What the operator typed → the API address a handheld can use, or ''. */
  function serverUrl(text) {
    var p = parse(text);
    if (!p) return '';
    var host = p.url.hostname;
    if (isLocalHost(host) || !/^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:]+\])$/i.test(host)) return '';
    /* URL() completes "192.168.3" into an address, so check what was typed. */
    var typedHost = p.typed.split(/[/:?#]/)[0];
    if (/^[\d.]+$/.test(typedHost) && !/^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(typedHost)) return '';
    if (!p.hasScheme && !p.url.port) p.url.port = '4000';
    return p.url.origin;
  }

  window.PdaDevice = { view: view, serverUrl: serverUrl, isLocalUrl: isLocalUrl };
})();
