export type PermissionDef = { key: string; label: string };
export type PermissionModule = { key: string; label: string; permissions: PermissionDef[] };

const groups: Array<[string, string, Array<[string, string]>]> = [
  ['dashboard', 'ภาพรวม', [['dashboard.view', 'ดูภาพรวม']]],
  ['box', 'กล่อง', [['box.view','ดูรายการกล่อง'],['box.detail','ดูรายละเอียดกล่อง'],['box.create','เพิ่มกล่อง'],['box.update','แก้ไขกล่อง'],['box.delete','ลบกล่อง'],['box.print','พิมพ์บาร์โค้ด'],['box.export','ส่งออกข้อมูล']]],
  ['transaction', 'รายการยืม–คืน', [['transaction.view','ดูรายการ'],['borrow.create','ทำรายการยืม'],['return.create','รับคืนกล่อง'],['transaction.update','แก้ไขรายการ'],['transaction.cancel','ยกเลิกรายการ'],['transaction.history','ดูประวัติ'],['overdue.manage','จัดการรายการเกินกำหนด']]],
  ['partner', 'ลูกค้าและคู่ค้า', [['partner.view','ดูลูกค้า'],['partner.create','เพิ่มลูกค้า'],['partner.update','แก้ไขลูกค้า'],['partner.delete','ลบลูกค้า'],['partner.history','ดูประวัติยืม–คืน']]],
  ['employee', 'พนักงาน', [['employee.view','ดูพนักงาน'],['employee.create','เพิ่มพนักงาน'],['employee.update','แก้ไขพนักงาน'],['employee.disable','ปิดใช้งานพนักงาน'],['employee.delete','ลบพนักงาน'],['employee.pin.manage','จัดการ PIN']]],
  ['report', 'รายงาน', [['report.view','ดูรายงาน'],['report.export','ส่งออกรายงาน'],['report.analytics','ดูสถิติ']]],
  ['setting', 'การตั้งค่า', [['setting.view','ดูการตั้งค่า'],['master.manage','จัดการข้อมูลหลัก'],['role.manage','จัดการบทบาท'],['permission.manage','จัดการสิทธิ์']]],
  ['warehouse', 'คลังสินค้า', [['warehouse.view','ดูคลังสินค้า'],['warehouse.manage','จัดการคลังสินค้า']]],
  ['gate', 'ประตู', [['gate.in','ทำรายการขาเข้า'],['gate.out','ทำรายการขาออก'],['gateprefs.manage','ตั้งค่าประตู']]],
  ['rfid', 'RFID', [['rfid.log','ดู RFID Log'],['rfid.manage','จัดการ RFID']]],
  ['lpr', 'ทะเบียนรถ', [['lpr.log','ดู Log ทะเบียนรถ'],['lpr.manage','จัดการ LPR']]],
  ['audit', 'ตรวจสอบ', [['audit.view','ดูประวัติการตรวจสอบ'],['audit.export','ส่งออกประวัติ']]],
  ['cycle_count', 'ตรวจนับ', [['cycle_count.view','ดูรายการตรวจนับ'],['cycle_count.manage','จัดการตรวจนับ']]],
  ['device', 'อุปกรณ์', [['device.manage','จัดการอุปกรณ์']]],
  ['notification', 'การแจ้งเตือน', [['notification.manage','จัดการการแจ้งเตือน']]],
  ['movement', 'ความเคลื่อนไหว', [['movement.view','ดูความเคลื่อนไหว']]],
  ['branding', 'แบรนด์ระบบ', [['branding.manage','จัดการแบรนด์']]],
  ['ui', 'หน้าจอ', [['ui.preferences','ตั้งค่าหน้าจอ']]],
  ['system', 'ระบบ', [['system.maintenance','บำรุงรักษาระบบ']]],
];

export const PERMISSION_MODULES: PermissionModule[] = groups.map(([key,label,items]) => ({
  key, label, permissions: items.map(([permission,label]) => ({ key: permission, label })),
}));
export const ALL_PERMISSIONS = PERMISSION_MODULES.flatMap((module) => module.permissions.map((item) => item.key));
export const PERMISSION_SET = new Set(ALL_PERMISSIONS);
export function sanitizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const chosen = new Set(value.filter((item): item is string => typeof item === 'string' && PERMISSION_SET.has(item)));
  return ALL_PERMISSIONS.filter((key) => chosen.has(key));
}
