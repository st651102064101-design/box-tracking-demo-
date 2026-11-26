/* Due-date rules behind the overdue window. Pure data: no DOM. */
(function () {
  function two(n) { return (n < 10 ? '0' : '') + n; }
  /** yyyy-mm-dd, as a date input uses it. */
  function day(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  function slash(d) { return two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function dmy(box) {
    if (box.dueDate) return box.dueDate;
    var d = new Date(box.dueAt || NaN);
    return isNaN(d.getTime()) ? '-' : slash(d);
  }
  /** The date `days` after the due date, or after today if that is later. */
  function after(box, days, now) {
    var due = Date.parse(box.dueAt);
    var from = new Date(Math.max(now.getTime(), isNaN(due) ? 0 : due));
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  }
  /** Moves the due date. Returns false, changing nothing, if that is not allowed. */
  function extend(box, text, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
    if (!m || box.status !== 'out') return false;
    var due = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
    if (day(due) !== text || due.getTime() < now.getTime()) return false;
    var before = dmy(box);
    box.dueAt = due.toISOString();
    box.dueDate = slash(due);
    (box.history = box.history || []).push({
      dir: 'due', ts: now.toISOString(), do: box.do, customer: box.customer, dueAt: box.dueAt,
      note: 'เลื่อนกำหนดคืน ' + before + ' → ' + box.dueDate,
    });
    return true;
  }
  window.Overdue = { dmy: dmy, day: day, after: after, extend: extend };
})();
