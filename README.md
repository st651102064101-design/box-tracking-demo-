# BoxTrace — RFID Gate · Returnable Asset Tracking (WMS)

ระบบติดตามกล่อง/ทรัพย์สินหมุนเวียน (returnable asset) ผ่านประตูสแกน RFID
พัฒนาต่อยอดจากไฟล์ต้นฉบับ `rfid-gate_v17-3d.html` ให้กลายเป็นระบบ **full-stack**
โดย **หน้าจอ (UI) เหมือนต้นฉบับ 100%** — ตัวแอปเดิมถูกนำมาใช้ทั้งไฟล์ แก้เพียง
บรรทัดเดียว (แทรก `<script src="/legacy-sync.js">`) เพื่อเชื่อมกับ backend + ฐานข้อมูล

```
┌──────────────────────────┐      /api/*        ┌──────────────────────────┐        ┌───────────────┐
│  Next.js 14 (port 3000)  │ ─── rewrite ────▶ │  Express 4 (port 4000)   │ ─────▶ │ PostgreSQL 16 │
│  • /login (React+TW)     │   proxy same-origin│  • JWT auth (bcrypt)     │ Drizzle│   (Docker)    │
│  • /legacy.html (แอปเดิม)│                    │  • /api/state bridge     │  ORM   └───────────────┘
└──────────────────────────┘                    │  • /api/gate, /api/boxes │
                                                 └──────────────────────────┘
```

---

## Stack

| Layer     | เทคโนโลยี                                                                                     |
|-----------|-----------------------------------------------------------------------------------------------|
| Frontend  | **Next.js 14.2.15** + **React 18.3.1** + **TailwindCSS** + **TypeScript** (port 3000)         |
| Backend   | **Node.js + Express 4.19** + **TypeScript**, **Drizzle ORM**, **JWT** + **bcryptjs**, **Zod** |
| Database  | **PostgreSQL 16** (alpine) ผ่าน **Docker**                                                    |
| Testing   | **Vitest** + **Supertest** (ใช้ **PGlite** เป็น Postgres ในหน่วยความจำ — ไม่ต้องมี DB server) |

---

## เริ่มใช้งานเร็วที่สุด — Docker (แนะนำ)

รันทั้งระบบ (db + backend + frontend) ด้วยคำสั่งเดียว:

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

- เปิดเบราว์เซอร์ที่ **http://localhost:3000**
- เข้าสู่ระบบด้วยบัญชีเริ่มต้น **admin / admin123** (สร้างอัตโนมัติตอน seed)
- backend รัน migrate + seed ให้อัตโนมัติก่อนเปิดพอร์ต

หยุดระบบ: `docker compose down` (ข้อมูลอยู่ใน volume `db-data`)

---

## รันแบบ Dev (แยกส่วน)

ต้องมี **Node 20+** และ **PostgreSQL** (จะใช้ Docker เฉพาะ DB ก็ได้)

```bash
# 1) ติดตั้ง dependencies ทั้งสองฝั่ง
npm run install:all

# 2) เปิด Postgres (เฉพาะ db) ด้วย Docker
npm run db:up
#    หรือชี้ DATABASE_URL ไปที่ Postgres ของคุณเองใน backend/.env

# 3) ตั้งค่า env
cp backend/.env.example backend/.env      # แก้ JWT_SECRET / DATABASE_URL
cp frontend/.env.example frontend/.env

# 4) สร้างตาราง + บัญชี admin
npm run db:migrate
npm run db:seed

# 5) รัน backend (:4000) และ frontend (:3000) คนละ terminal
npm run dev:backend
npm run dev:frontend
```

> **รันเร็วแบบไม่ต้องมี Postgres:** ตั้ง `USE_PGLITE=true` ใน `backend/.env`
> จะใช้ PGlite (Postgres ใน process) เก็บไฟล์ที่ `PGLITE_DIR` — เหมาะกับ demo/ทดลอง

---

## กลยุทธ์ "เหมือน 100% · copy วางได้เลย"

ไฟล์ต้นฉบับถูกเก็บไว้ 2 ที่:

- `reference/rfid-gate_v17-3d.html` — **ต้นฉบับเป๊ะ ไม่แตะเลย** (ไว้เทียบ diff)
- `frontend/public/legacy.html` — ไฟล์เดียวกัน **ต่างกันแค่บรรทัดเดียว** คือแทรก
  `<script src="/legacy-sync.js"></script>` ใน `<head>`

แอปเดิมเคยเก็บ state ทั้งก้อน (`S`) ไว้ใน `localStorage` (คีย์ `boxtrace_p1`)
ตัวเชื่อม `frontend/public/legacy-sync.js` ทำหน้าที่ (โดยไม่แก้ลอจิกเดิมสักบรรทัด):

1. **ดักจับ** `localStorage.setItem('boxtrace_p1', …)` → ส่ง `PUT /api/state` แบบ debounce
   → บันทึกลง PostgreSQL
2. **ตอน boot** ดึง `GET /api/state` มา แล้วเรียก `load()` + `renderAll()` ของแอปเดิม
   เพื่อแสดงข้อมูลจากเซิร์ฟเวอร์ (เซิร์ฟเวอร์เป็น source of truth)
3. ปุ่ม **logout** ผูกกับชิปบัญชี (`.who`) ที่มีอยู่แล้ว — ไม่เพิ่ม UI ใหม่

ผลลัพธ์: อยากพัฒนา UI ต่อ ก็แก้ `frontend/public/legacy.html` ได้ตรง ๆ เหมือนเดิม
พร้อมกับมี Next.js/React + Tailwind ไว้เขียนหน้าจอใหม่ และ backend/DB จริงรออยู่แล้ว

> **หมายเหตุเรื่องอินเทอร์เน็ต:** แอปเดิมโหลด Three.js (มุมมองคลัง 3D) และฟอนต์
> จาก CDN (unpkg / Google Fonts) จึงต้องมีเน็ตตอนเปิดหน้าจอ หากต้องการใช้แบบ
> ออฟไลน์ ให้ดาวน์โหลดไฟล์เหล่านั้นมาไว้ใน `frontend/public/` แล้วแก้ URL ในไฟล์

---

## โครงสร้างโปรเจกต์

```
.
├─ docker-compose.yml          # db (Postgres 16) + backend + frontend
├─ reference/
│  └─ rfid-gate_v17-3d.html    # ต้นฉบับ 100% (ไม่แก้)
├─ backend/
│  ├─ src/
│  │  ├─ index.ts              # bootstrap + listen
│  │  ├─ app.ts                # express app (แยกไว้ให้ Supertest เรียก)
│  │  ├─ env.ts                # config จาก env
│  │  ├─ db/
│  │  │  ├─ schema.ts          # Drizzle schema (ทุก entity)
│  │  │  ├─ schema.sql          # DDL (bootstrap Postgres + PGlite test)
│  │  │  ├─ client.ts           # driver สลับ Postgres ↔ PGlite
│  │  │  └─ migrate.ts
│  │  ├─ routes/               # auth, state, gate, boxes, masters
│  │  ├─ services/             # state (bridge), gate (business logic)
│  │  ├─ middleware/           # auth (JWT), error
│  │  ├─ lib/                  # jwt, password (bcrypt)
│  │  ├─ validators/           # Zod schemas
│  │  └─ seed.ts               # สร้างบัญชี admin
│  └─ tests/                   # Vitest + Supertest (auth, state, gate)
└─ frontend/
   ├─ app/                     # /login (React) + / (auth gate) + layout
   ├─ lib/api.ts               # fetch wrapper + token
   ├─ public/
   │  ├─ legacy.html           # แอปเดิม (เหมือน 100% + 1 บรรทัด)
   │  └─ legacy-sync.js        # ตัวเชื่อม localStorage ↔ API
   └─ next.config.js           # rewrite /api/* → backend
```

---

## API สรุป

ทุก endpoint ยกเว้น `auth` และ `health` ต้องมี header `Authorization: Bearer <jwt>`

| Method | Path                         | หน้าที่                                             |
|--------|------------------------------|-----------------------------------------------------|
| GET    | `/api/health`                | health check                                        |
| POST   | `/api/auth/register`         | สมัครผู้ใช้ → คืน `{ token, user }`                  |
| POST   | `/api/auth/login`            | เข้าสู่ระบบ → คืน `{ token, user }`                  |
| GET    | `/api/auth/me`               | ข้อมูลผู้ใช้ปัจจุบัน                                 |
| GET    | `/api/state`                 | ดึง state ทั้งก้อน (`S`) — ใช้โดยแอปเดิม             |
| PUT    | `/api/state`                 | แทนที่ state ทั้งก้อน (transaction) — ใช้โดยแอปเดิม  |
| POST   | `/api/gate/out`              | บันทึกกล่องออก (status → `out`, ตั้ง due date)       |
| POST   | `/api/gate/in`               | รับกล่องกลับ (status → `warehouse`, cycles++)        |
| GET    | `/api/boxes`                 | รายการกล่อง (กรอง `?status=` `?customer=`)           |
| GET    | `/api/boxes/:tag`            | กล่องรายใบ                                           |
| GET/POST/PUT/DELETE | `/api/masters/box-types`, `/api/masters/customers` | CRUD ข้อมูลหลัก (ตัวอย่างรูปแบบ) |

---

## ฐานข้อมูล

โมเดลตาม state `S` เดิม แบบ **hybrid relational + JSONB**: แต่ละ entity มีคอลัมน์
ที่ query ได้จริง (status, customer, due date, …) และเก็บ object เดิมทั้งก้อนใน
คอลัมน์ `data` (JSONB) เพื่อให้ round-trip กับ UI เดิมได้ครบ 100% ไม่สูญข้อมูล

ตาราง: `users`, `config`, `sequences`, `customers`, `box_types`, `warehouses`,
`gates`, `locations`, `employees`, `boxes`, `vehicles`, `do_records`, `putaway`,
`inventory`, `events`, `audit_log`

ปรับ schema: แก้ `backend/src/db/schema.ts` แล้ว `npm --prefix backend run db:generate`
(drizzle-kit) เพื่อสร้าง migration สำหรับ Postgres จริง

---

## เทสต์

```bash
npm test          # รัน Vitest ทั้งหมด (ใช้ PGlite ในหน่วยความจำ ไม่ต้องมี DB)
```

ครอบคลุม: auth (login/register/protected), state bridge (round-trip `S` ครบถ้วน),
gate operations (out/in + สถานะ + cycles)
