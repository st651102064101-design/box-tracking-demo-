import { z } from 'zod';

/* ─── auth ─────────────────────────────────────────────────────────────────*/
export const loginSchema = z.object({
  username: z.string().min(1, 'กรุณากรอกชื่อผู้ใช้'),
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน'),
});

export const registerSchema = z.object({
  username: z.string().min(3, 'ชื่อผู้ใช้อย่างน้อย 3 ตัวอักษร'),
  password: z.string().min(6, 'รหัสผ่านอย่างน้อย 6 ตัวอักษร'),
  name: z.string().min(1, 'กรุณากรอกชื่อ'),
  // Required so "ลืมรหัสผ่าน?" always has somewhere to send the reset OTP —
  // accounts created before this existed just won't have one on file yet
  // (see the 'no_email_on_file' error on POST /auth/forgot-password).
  email: z.string().trim().email('อีเมลไม่ถูกต้อง').max(254, 'อีเมลยาวเกินไป'),
  // No `role` here: every self-registration starts as 'staff', promoted only
  // via the admin-only PATCH /api/auth/users/:id/role endpoint.
});

export const forgotPasswordRequestSchema = z.object({
  username: z.string().min(1, 'กรุณากรอกชื่อผู้ใช้'),
});

export const resetPasswordSchema = z.object({
  username: z.string().min(1, 'กรุณากรอกชื่อผู้ใช้'),
  otp: z.string().regex(/^\d{6}$/, 'OTP ต้องเป็นตัวเลข 6 หลัก'),
  password: z.string().min(6, 'รหัสผ่านอย่างน้อย 6 ตัวอักษร'),
});

export const linkEmployeeSchema = z.object({
  userId: z.number().int().positive().nullable(),
});

export const updateRoleSchema = z.object({
  role: z.enum(['admin', 'staff', 'viewer']),
});

/* ─── full application state (the localStorage `S` snapshot) ────────────────
 * Deliberately permissive: the legacy UI is the source of truth for the exact
 * shape of every record, so we accept it verbatim and never reject valid data.
 * Typed columns are extracted best-effort on the server side. */
const record = z.record(z.any());
export const stateSchema = z.object({
  boxes: record.optional().default({}),
  customers: record.optional().default({}),
  boxtypes: record.optional().default({}),
  warehouses: record.optional().default({}),
  gates: record.optional().default({}),
  events: z.array(z.any()).optional().default([]),
  cfg: z
    .object({
      agingDays: z.number().optional(),
      boxValue: z.number().optional(),
      lostMode: z.string().optional(),
    })
    .passthrough()
    .optional()
    .default({}),
  seq: z.record(z.number()).optional().default({}),
  vehicles: record.optional().default({}),
  putaway: record.optional().default({}),
  doRecords: record.optional().default({}),
  employees: record.optional().default({}),
  locations: record.optional().default({}),
  inventory: record.optional().default({}),
  auditLog: z.array(z.any()).optional().default([]),
});
export type StatePayload = z.infer<typeof stateSchema>;

/* ─── master-data CRUD (representative, strictly typed) ─────────────────────*/
export const boxTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().nullish(),
  value: z.number().nullable().optional(),
  dim: z.string().nullish(),
});

export const customerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  addr: z.string().nullish(),
  contact: z.string().nullish(),
  returnDays: z.number().int().nonnegative().nullish(),
});

/* ─── gate operations ──────────────────────────────────────────────────────*/
export const gateOutSchema = z.object({
  tags: z.array(z.string().min(1)).min(1, 'ต้องมีอย่างน้อย 1 กล่อง'),
  customer: z.string().min(1, 'ต้องระบุลูกค้า'),
  gate: z.number().int().positive(),
  doNo: z.string().optional(),
  po: z.string().optional(),
  /** Employee master id (EMP-xxxx) of the operator who scanned this batch. */
  employeeId: z.string().optional(),
  recorder: z.string().optional(),
  plate: z.string().optional(),
  driver: z.string().optional(),
  vehicleType: z.string().optional(),
});

/* ─── RFID tag association ─────────────────────────────────────────────────*/
const HEX = /^[0-9A-Fa-f]+$/;
export const rfidAssociateSchema = z.object({
  /** Optional: the MC3390R never reports a TID during inventory, and reading
   *  one explicitly means halting the inventory, so the PDA commissions tags
   *  by EPC alone. Still accepted from any client that does have one. */
  rfidTid: z.string().regex(HEX, 'TID ต้องเป็นเลขฐาน 16').min(8).optional(),
  rfidEpc: z.string().regex(HEX, 'EPC ต้องเป็นเลขฐาน 16').min(8),
  /** Must be set explicitly to overwrite a box that already carries a tag —
   *  the "damaged tag, put on a new one" flow. Omitted/false on a box with
   *  no tag yet just associates normally. */
  replace: z.boolean().optional().default(false),
});

export const gateInSchema = z.object({
  tags: z.array(z.string().min(1)).min(1, 'ต้องมีอย่างน้อย 1 กล่อง'),
  gate: z.number().int().positive(),
  /** Employee master id (EMP-xxxx) of the operator who scanned this batch. */
  employeeId: z.string().optional(),
  recorder: z.string().optional(),
  plate: z.string().optional(),
  driver: z.string().optional(),
  vehicleType: z.string().optional(),
  /** Per-tag condition an operator flagged while scanning this batch in —
   *  a box marked here lands on 'hold' or 'damage' instead of 'warehouse',
   *  same statuses legacy.html's own box list already filters by. Any tag
   *  not present here is assumed fine and goes straight to 'warehouse'. */
  conditions: z.record(z.string(), z.enum(['hold', 'damage'])).optional(),
});
