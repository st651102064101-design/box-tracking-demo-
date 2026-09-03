/**
 * ============================================================================
 * BoxTrace — permission catalog (RBAC)
 * ----------------------------------------------------------------------------
 * Permissions are DEVELOPER-defined and live only here. Admins compose them
 * into roles (see routes/roles.ts) but can never invent a new permission key:
 * a key that no route checks would be a lie on the screen, and a route that
 * checks a key nobody can grant would lock everyone out. Keeping the list in
 * code is what keeps those two halves honest.
 *
 * The frontend renders its permission picker straight from
 * GET /api/roles/permissions, so the Thai labels here are the ones the admin
 * actually reads — this file is the single source for both.
 * ============================================================================
 */

export interface PermissionDef {
  key: string;
  label: string;
}
export interface PermissionModule {
  key: string;
  label: string;
  permissions: PermissionDef[];
}

export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    permissions: [{ key: 'dashboard.view', label: 'ดู Dashboard' }],
  },
  {
    key: 'box',
    label: 'กล่อง',
    permissions: [
      { key: 'box.view', label: 'ดูรายการกล่อง' },
      { key: 'box.detail', label: 'ดูรายละเอียดกล่อง' },
      { key: 'box.create', label: 'เพิ่มกล่อง' },
      { key: 'box.update', label: 'แก้ไขกล่อง' },
      { key: 'box.delete', label: 'ลบกล่อง' },
      { key: 'box.print', label: 'พิมพ์ Barcode / QR' },
      { key: 'box.export', label: 'Export ข้อมูลกล่อง' },
    ],
  },
  {
    key: 'transaction',
    label: 'ยืม / คืนกล่อง',
    permissions: [
      { key: 'transaction.view', label: 'ดูรายการ' },
      { key: 'borrow.create', label: 'สร้างรายการยืม' },
      { key: 'return.create', label: 'รับคืนกล่อง' },
      { key: 'transaction.update', label: 'แก้ไขรายการ' },
      { key: 'transaction.cancel', label: 'ยกเลิกรายการ' },
      { key: 'transaction.history', label: 'ดูประวัติ' },
      { key: 'overdue.manage', label: 'จัดการรายการเกินกำหนด' },
    ],
  },
  {
    key: 'partner',
    label: 'ลูกค้า / Supplier',
    permissions: [
      { key: 'partner.view', label: 'ดู' },
      { key: 'partner.create', label: 'เพิ่ม' },
      { key: 'partner.update', label: 'แก้ไข' },
      { key: 'partner.delete', label: 'ลบ' },
      { key: 'partner.history', label: 'ดูประวัติยืม–คืน' },
    ],
  },
  {
    key: 'employee',
    label: 'พนักงาน',
    permissions: [
      { key: 'employee.view', label: 'ดูพนักงาน' },
      { key: 'employee.create', label: 'เพิ่มพนักงาน' },
      { key: 'employee.update', label: 'แก้ไขพนักงาน' },
      { key: 'employee.disable', label: 'ปิดใช้งานพนักงาน' },
      { key: 'employee.delete', label: 'ลบพนักงาน' },
    ],
  },
  {
    key: 'report',
    label: 'รายงาน',
    permissions: [
      { key: 'report.view', label: 'ดูรายงาน' },
      { key: 'report.export', label: 'Export รายงาน' },
      { key: 'report.analytics', label: 'ดูข้อมูลเชิงวิเคราะห์' },
    ],
  },
  {
    key: 'operations',
    label: 'งานปฏิบัติการคลัง',
    permissions: [
      { key: 'cycle_count.view', label: 'ดูงานตรวจนับสต็อก' },
      { key: 'cycle_count.manage', label: 'เปิด/สแกน/ปิดงานตรวจนับสต็อก' },
      { key: 'movement.view', label: 'ดูประวัติการเคลื่อนไหว' },
    ],
  },
  {
    key: 'warehouse',
    label: 'คลังและประตู',
    permissions: [
      { key: 'warehouse.view', label: 'ดูคลังและประตู' },
      { key: 'warehouse.manage', label: 'จัดการคลังและประตู' },
      { key: 'gate.in', label: 'ทำรายการผ่านประตูขาเข้า' },
      { key: 'gate.out', label: 'ทำรายการผ่านประตูขาออก' },
    ],
  },
  {
    key: 'integration',
    label: 'อุปกรณ์และการเชื่อมต่อ',
    permissions: [
      { key: 'rfid.manage', label: 'จัดการ RFID / FX9600' },
      { key: 'rfid.log', label: 'ดู RFID Webhook Log' },
      { key: 'lpr.manage', label: 'จัดการ LPR' },
      { key: 'lpr.log', label: 'ดู LPR Event Log' },
      { key: 'device.manage', label: 'จัดการอุปกรณ์ PDA' },
      { key: 'gateprefs.manage', label: 'จัดการค่าการทำงานของประตู' },
    ],
  },
  {
    key: 'security',
    label: 'ความปลอดภัยและการตรวจสอบ',
    permissions: [
      { key: 'audit.view', label: 'ดู Audit Log' },
      { key: 'audit.export', label: 'Export Audit Log' },
      { key: 'notification.manage', label: 'จัดการการแจ้งเตือน' },
      { key: 'ui.preferences', label: 'จัดการค่าการแสดงผลส่วนตัว' },
      { key: 'branding.manage', label: 'จัดการชื่อระบบและโลโก้' },
      { key: 'employee.pin.manage', label: 'จัดการ PIN พนักงาน' },
      { key: 'system.maintenance', label: 'จัดการบำรุงรักษาและล้างข้อมูลระบบ' },
    ],
  },
  {
    key: 'setting',
    label: 'การตั้งค่าระบบ',
    permissions: [
      { key: 'setting.view', label: 'ดูการตั้งค่า' },
      { key: 'master.manage', label: 'แก้ไข Master Data' },
      { key: 'role.manage', label: 'จัดการ Role' },
      { key: 'permission.manage', label: 'จัดการ Permission ของ Role' },
    ],
  },
];

/** Every permission key that exists, in catalog order. */
export const ALL_PERMISSIONS: string[] = PERMISSION_MODULES.flatMap((m) =>
  m.permissions.map((p) => p.key),
);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

/** Drops anything that isn't a real permission key — the API accepts a role's
 *  permission list from the client, and a typo'd key stored in the DB would
 *  show up as a phantom checkbox nobody can ever satisfy. */
export function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw === 'string' && PERMISSION_SET.has(raw)) seen.add(raw);
  }
  // Catalog order, not client order, so stored rows compare/diff predictably.
  return ALL_PERMISSIONS.filter((k) => seen.has(k));
}

export function isPermission(key: string): boolean {
  return PERMISSION_SET.has(key);
}

/* ─── built-in roles ──────────────────────────────────────────────────────
 * Seeded once (see seed.ts / db/migrate.ts). Only SUPER_ADMIN is `system`:
 * it always holds every permission, cannot be renamed away from its key,
 * disabled, stripped, or deleted — it's the door back in when a badly built
 * custom role locks everyone else out.
 * The legacy `users.role` strings (admin/staff/viewer) map onto these so
 * accounts created before RBAC keep working untouched — see roleKeyForLegacy.
 */
export const SUPER_ADMIN_KEY = 'super_admin';

export interface SeedRole {
  key: string;
  name: string;
  description: string;
  system?: boolean;
  permissions: string[];
}

const WAREHOUSE_MANAGER_PERMS = [
  'dashboard.view',
  'box.view', 'box.detail', 'box.create', 'box.update', 'box.print', 'box.export',
  'transaction.view', 'borrow.create', 'return.create', 'transaction.update',
  'transaction.cancel', 'transaction.history', 'overdue.manage',
  'partner.view', 'partner.create', 'partner.update', 'partner.history',
  'employee.view',
  'warehouse.view', 'warehouse.manage', 'gate.in', 'gate.out',
  'rfid.manage', 'rfid.log', 'lpr.manage', 'device.manage',
  'cycle_count.view', 'cycle_count.manage', 'movement.view',
  'report.view', 'report.export', 'report.analytics',
  'setting.view',
];

const WAREHOUSE_STAFF_PERMS = [
  'dashboard.view',
  'box.view', 'box.detail', 'box.create', 'box.update', 'box.print',
  'transaction.view', 'borrow.create', 'return.create', 'transaction.history',
  'partner.view',
  'warehouse.view', 'gate.in', 'gate.out',
  'cycle_count.view', 'cycle_count.manage', 'movement.view',
];

const VIEWER_PERMS = [
  'dashboard.view',
  'box.view', 'box.detail',
  'transaction.view',
  'partner.view',
];

export const SEED_ROLES: SeedRole[] = [
  {
    key: SUPER_ADMIN_KEY,
    name: 'Super Admin',
    description: 'สิทธิ์ทั้งหมดในระบบ — แก้ไขหรือลบไม่ได้',
    system: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    /* Same reach as Super Admin, but an ordinary role: it can be renamed,
       re-scoped or deleted. The difference that matters is the lock, not the
       permission list — and an "Admin" that couldn't hand out permissions
       would strand any database whose only account predates RBAC (those
       backfill onto this role, not Super Admin). */
    key: 'admin',
    name: 'Admin',
    description: 'ผู้ดูแลระบบ — จัดการข้อมูลหลัก บทบาท และพนักงาน',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'warehouse_manager',
    name: 'ผู้จัดการคลัง',
    description: 'ดูแลงานคลังทั้งหมด ทำรายการยืม–คืน และดูรายงาน',
    permissions: WAREHOUSE_MANAGER_PERMS,
  },
  {
    key: 'warehouse_staff',
    name: 'เจ้าหน้าที่คลัง',
    description: 'สามารถจัดการกล่อง ทำรายการยืม/คืน และดูข้อมูลลูกค้า',
    permissions: WAREHOUSE_STAFF_PERMS,
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'ดูข้อมูลได้อย่างเดียว ทำรายการไม่ได้',
    permissions: VIEWER_PERMS,
  },
];

/** Legacy `users.role` → seeded role key, for accounts that predate role_id. */
export function roleKeyForLegacy(legacyRole: string | undefined | null): string {
  switch ((legacyRole ?? '').toLowerCase()) {
    case 'admin':
      return 'admin';
    case 'viewer':
      return 'viewer';
    case 'supervisor':
      return 'warehouse_manager';
    default:
      return 'warehouse_staff'; // 'staff', 'operator', anything unknown
  }
}
