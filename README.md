# GTRP Unified License System V1.0

ระบบ License กลางสำหรับผลิตภัณฑ์ GTRP: **License เดียว บัญชีลูกค้าเดียว** ใช้ควบคุมสิทธิ์ทั้ง

* **GTRP Quant Analysis Web App** (ตรวจสิทธิ์ฟีเจอร์ฝั่งเซิร์ฟเวอร์ทุกคำขอ)
* **GTRP EA สำหรับ MT4 (MQL4) และ MT5 (MQL5)** (ใช้ WebRequest ไม่ใช้ DLL ได้รับ lease ที่ลงนามด้วย Ed25519)
* **Admin Dashboard** สำหรับจัดการลูกค้า แผน License เครื่องที่เปิดใช้ การชำระเงิน และ audit log

ทำงานบน Cloudflare Workers + D1, เขียนด้วย TypeScript (Hono) และ React + Vite

> ระบบนี้ **ไม่ส่งคำสั่งเทรด** จากเซิร์ฟเวอร์ ไม่เก็บรหัสผ่านโบรกเกอร์ และ **ไม่ได้อ้างว่าป้องกันการแก้ไขฝั่ง client ได้ 100%** ดูข้อจำกัดใน [docs/SECURITY.md](docs/SECURITY.md#known-limitations)

## โครงสร้างโปรเจกต์

```
apps/api/                 Cloudflare Worker: REST API /api/v1 + ให้บริการไฟล์ dashboard
apps/admin/               Admin Dashboard (React + Vite)
packages/shared/          schema (zod), error codes, state machine ของ License, ตัวตรวจ lease
ea-examples/
  include/GTRPLicense.mqh ไลบรารีตรวจ License สำหรับ MQL4/MQL5
  mt4/, mt5/              ตัวอย่าง EA (ไม่มีกลยุทธ์เทรด)
  reference-client/       ต้นแบบ client ภาษา TypeScript พร้อมชุดทดสอบ (สเปกที่รันได้ของ EA)
migrations/               D1 migrations (+ rollback/ สำหรับย้อนกลับด้วยมือ)
scripts/                  สร้าง secrets dev, สร้าง admin, seed ข้อมูล dev, จำลองการชำระเงิน
docs/                     เอกสารทั้งหมด (ดูด้านล่าง)
.github/workflows/        CI และ Deploy
```

## เริ่มต้นสำหรับนักพัฒนา (Local)

ต้องมี Node.js 22+ และ pnpm 10 (`corepack enable`)

```bash
pnpm install
pnpm secrets:dev                 # สร้าง apps/api/.dev.vars (secrets สำหรับเครื่อง dev เท่านั้น, ไม่ถูก commit)
pnpm db:migrate:local            # สร้างฐานข้อมูล D1 ในเครื่อง
pnpm db:seed:local               # (ไม่บังคับ) แผนตัวอย่าง ANALYSIS / QUANT_PRO / QUANT_AUTO ราคา 0
node scripts/create-admin.mjs admin@gtrp.local --local   # สร้างผู้ดูแล (รหัสผ่านพิมพ์ตอนถาม)

pnpm --filter @gtrp/admin build  # สร้างไฟล์ dashboard ให้ Worker ให้บริการ
pnpm dev:api                     # http://127.0.0.1:8787  (API + dashboard)
# หรือพัฒนา dashboard แบบ hot reload:  pnpm dev:admin  → http://localhost:5173 (proxy /api ไปที่ 8787)
```

ตรวจว่าระบบพร้อม: `curl http://127.0.0.1:8787/api/v1/health` ต้องได้ `"status":"ok"`

ใน development ไม่บังคับ MFA สำหรับ admin (staging/production บังคับ) และเปิดผู้ให้บริการชำระเงิน **จำลอง** ไว้ ทดสอบได้ด้วย `node scripts/mock-payment.mjs <provider_ref> <amount_minor>`

## คำสั่งที่ใช้บ่อย

| คำสั่ง | ทำอะไร |
| --- | --- |
| `pnpm typecheck` | ตรวจ type ทุก package |
| `pnpm test` | รันชุดทดสอบทั้งหมด (shared, API บน Workers runtime จริง, dashboard, EA reference client) |
| `pnpm build` | build dashboard แล้ว bundle Worker (dry run, ไม่ deploy) |
| `pnpm db:migrate:local` | apply migrations ในเครื่อง |

ผลการทดสอบล่าสุด: 172 tests ผ่านทั้งหมด (shared 23, API 121, dashboard 13, EA reference client 15) ทดสอบทั้งในเครื่องและใน clone ใหม่แบบเดียวกับ CI

## เอกสาร

| เอกสาร | เนื้อหา |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | สถาปัตยกรรม, data model, state machine, การกันโควตาซ้อน |
| [docs/API.md](docs/API.md) | API ทุก endpoint, รูปแบบ error, rate limit, webhook |
| [docs/EA_INTEGRATION_TH.md](docs/EA_INTEGRATION_TH.md) | คู่มือเชื่อม EA (ภาษาไทย): WebRequest, schema คำขอ/คำตอบ, การรับมือ error |
| [docs/ADMIN_GUIDE_TH.md](docs/ADMIN_GUIDE_TH.md) | คู่มือผู้ดูแลระบบ (ภาษาไทย) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | คู่มือ deploy staging/production (ภาษาไทย) |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model, มาตรการความปลอดภัย, security checklist, ข้อจำกัดที่ทราบ |
| [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) | สำรอง/กู้คืน D1, migration, rollback |
| [docs/PRIVACY_AND_DATA_RETENTION.md](docs/PRIVACY_AND_DATA_RETENTION.md) | ข้อมูลที่เก็บ ระยะเวลาเก็บ และร่างประกาศความเป็นส่วนตัว (ภาษาไทย) **สำหรับให้ทนายตรวจ** |
| [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | checklist ก่อนปล่อย, ตาราง acceptance criteria, งานที่ควรทำต่อ |

## หลักการสำคัญ

* License Key รูปแบบ `GTRP-XXXX-XXXX-XXXX-XXXX` แสดงครั้งเดียว เก็บเฉพาะค่า HMAC hash
* ไม่มี License Key ใน URL หรือ log, session token เก็บเป็น hash, ข้อมูลอ่อนไหวถูก redact
* private key สำหรับลงนาม lease อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น EA มีได้แค่ public key
* เครือข่ายล่มไม่เท่ากับถูกเพิกถอน: EA ใช้งานต่อได้ภายในช่วง offline grace ที่จำกัด และ **ไม่ขัดขวางการดูแล order ที่เปิดอยู่** เสมอ
* การชำระเงินจริง **ปิดอยู่** จนกว่าจะเชื่อมผู้ให้บริการจริง ผู้ให้บริการจำลองใช้ได้เฉพาะ dev/staging

## สถานะและข้อจำกัด

* โค้ด MQL4/MQL5 ยังไม่ได้ compile ใน MetaEditor (สภาพแวดล้อมที่พัฒนาไม่มี MetaTrader) ต้องทดสอบบนบัญชี demo ตาม checklist ก่อนแจกจ่าย
* ยังไม่มีระบบอีเมล (รีเซ็ตรหัสผ่าน/ยืนยันอีเมล) และยังไม่มีผู้ให้บริการชำระเงินจริง
* ต้องใช้ Cloudflare Workers Paid plan

รายละเอียดทั้งหมด: [docs/SECURITY.md](docs/SECURITY.md#known-limitations) และ [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md#known-limitations-and-follow-up-tasks)
