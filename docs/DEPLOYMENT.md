# คู่มือ Deploy (Staging และ Production)

เอกสารนี้อธิบายการติดตั้ง GTRP License System บน Cloudflare ตั้งแต่ศูนย์ ทุกคำสั่งรันจากโฟลเดอร์ `apps/api` เว้นแต่ระบุไว้

> ทำ Staging ให้ผ่านทุกข้อก่อน แล้วค่อยทำ Production ด้วยขั้นตอนเดียวกัน โดยใช้ secrets ชุดใหม่ทั้งหมด

## 1. สิ่งที่ต้องมี

* บัญชี Cloudflare ที่เปิด **Workers Paid plan** (จำเป็น เพราะการ hash รหัสผ่าน PBKDF2 100,000 รอบใช้ CPU เกินโควตาของ Free plan)
* โดเมนที่อยู่ใน Cloudflare สำหรับ Production เช่น `license.example.com`
* Node.js 22 ขึ้นไป และ pnpm 10 (`corepack enable`)
* เครื่องที่เชื่อถือได้สำหรับสร้าง secrets (ไม่ใช่เครื่องสาธารณะ)

```bash
pnpm install --frozen-lockfile   # ที่ root ของ repo
cd apps/api
npx wrangler login
```

## 2. สร้างฐานข้อมูล D1

```bash
npx wrangler d1 create gtrp-license-staging
npx wrangler d1 create gtrp-license-production
```

นำ `database_id` ที่ได้ไปแทน `REPLACE_WITH_STAGING_D1_DATABASE_ID` และ `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` ใน `apps/api/wrangler.toml` แล้ว commit (database id ไม่ใช่ความลับ)

## 3. ตั้งค่าตัวแปร (vars) ใน wrangler.toml

ตรวจ `[env.staging.vars]` และ `[env.production.vars]`:

| ตัวแปร | Staging | Production |
| --- | --- | --- |
| `APP_ORIGINS` | URL ของ staging (และ Web App staging) | origin จริงทั้งหมด คั่นด้วย comma ห้ามใช้ `*` |
| `COOKIE_SECURE` | `true` | `true` |
| `REQUIRE_ADMIN_MFA` | `true` | `true` |
| `PAYMENTS_MOCK_ENABLED` | `true` ได้ (เพื่อทดสอบ) | **`false` เสมอ** (โค้ดปฏิเสธ mock ใน production อยู่แล้ว) |
| `LEASE_SIGNING_KEY_ID` | เช่น `stg-1` | เช่น `prod-1` |
| `LEASE_TTL_SECONDS` | `86400` | `86400` (คือระยะ offline grace สูงสุดของ EA) |
| `REVALIDATE_AFTER_SECONDS` | `1800` | `1800` |
| `SESSION_TTL_HOURS` | `12` | `8` |

สำหรับ Production ให้เปิดบรรทัด `routes = [{ pattern = "license.example.com", custom_domain = true }]` และเปลี่ยนเป็นโดเมนจริง

## 4. สร้างและตั้งค่า Secrets

สร้างค่าใหม่บนเครื่องที่เชื่อถือได้ (ค่าจะแสดงบนหน้าจอเท่านั้น ไม่ถูกเขียนลงไฟล์):

```bash
node ../../scripts/generate-dev-secrets.mjs --print
```

แล้วใส่ทีละค่า (วางค่าเมื่อโปรแกรมถาม ไม่ต้องใส่เครื่องหมาย `'` ครอบ):

```bash
npx wrangler secret put LICENSE_KEY_PEPPER        --env staging
npx wrangler secret put LEASE_SIGNING_PRIVATE_JWK --env staging
npx wrangler secret put MFA_ENCRYPTION_KEY        --env staging
npx wrangler secret put MOCK_PAYMENT_WEBHOOK_SECRET --env staging   # เฉพาะ staging ถ้าต้องการทดสอบการชำระเงินจำลอง
```

ทำซ้ำด้วย `--env production` โดยใช้ค่า **ชุดใหม่** (ไม่ต้องตั้ง `MOCK_PAYMENT_WEBHOOK_SECRET` ใน production) จากนั้นล้างหน้าจอ terminal และเก็บสำเนา `LICENSE_KEY_PEPPER` กับ `MFA_ENCRYPTION_KEY` แบบเข้ารหัสไว้ offline

| Secret | ถ้าหาย/เปลี่ยน จะเกิดอะไร |
| --- | --- |
| `LICENSE_KEY_PEPPER` | License Key, device id, account ref ทั้งหมดใช้ไม่ได้ ต้อง reissue key ให้ลูกค้าทุกคน **ห้ามเปลี่ยนหลังเปิดใช้งาน** |
| `LEASE_SIGNING_PRIVATE_JWK` | lease เดิมใช้ไม่ได้ EA จะ validate ใหม่ด้วย key โดยอัตโนมัติ (ดูการหมุนกุญแจด้านล่าง) |
| `MFA_ENCRYPTION_KEY` | admin ทุกคนต้องลงทะเบียน MFA ใหม่ |

## 5. Migration, Build และ Deploy

```bash
# ที่ root
pnpm typecheck && pnpm test
pnpm --filter @gtrp/admin build          # สร้าง apps/admin/dist ซึ่ง Worker ให้บริการเป็น static assets

cd apps/api
npx wrangler d1 migrations apply DB --remote --env staging
npx wrangler deploy --env staging
curl -s https://<staging-host>/api/v1/health
```

ผลที่ต้องได้: `"status":"ok"` และ `"checks":{"database":"ok","config":"ok"}` ถ้า `config` เป็น `error` แปลว่า secret ตั้งไม่ครบหรือรูปแบบผิด

## 6. สร้างผู้ดูแลระบบคนแรก

```bash
# ที่ root ของ repo; รหัสผ่านรับจากตัวแปรแวดล้อมหรือพิมพ์ตอนถาม (ไม่ใส่ใน command line)
node scripts/create-admin.mjs admin@your-company.com --env staging
```

เปิด `https://<host>/` เข้าสู่ระบบ ระบบจะบังคับลงทะเบียน MFA (Google Authenticator, 1Password ฯลฯ) ก่อนใช้งาน จากนั้นสร้าง Plan จริงในหน้า **Plans** (ไม่มี plan สำเร็จรูปใน production; `scripts/seed-dev.sql` ใช้สำหรับเครื่อง dev เท่านั้น)

## 7. ทดสอบ Staging ก่อน Production

- [ ] `/api/v1/health` ok
- [ ] admin login + MFA ได้ และ customer เข้า `/admin` ไม่ได้
- [ ] สร้าง plan และ license, เห็น key ครั้งเดียว
- [ ] EA บนบัญชี demo: activate, refresh, suspend แล้ว EA หยุดเปิด order ใหม่ภายในรอบตรวจถัดไป, reactivate แล้วกลับมาใช้ได้
- [ ] Web App: `/features/:feature/access` ตอบ 200 สำหรับ feature ที่มีสิทธิ์ และ 403 เมื่อ suspend
- [ ] การชำระเงินจำลอง (ถ้าเปิด): checkout แล้วส่ง webhook ที่ลงนามถูกต้อง ได้ license ใหม่ ส่งซ้ำแล้วได้ `duplicate`
- [ ] cron ทำงาน (ดู log `maintenance_completed` ใน Workers Logs)

## 8. Production

ทำขั้นตอน 2–6 ด้วย `--env production` แล้ว:

1. ผูก custom domain (ขั้นตอน 3) และตรวจว่า `workers_dev = false`
2. ตั้ง `APP_ORIGINS` ให้ตรงกับโดเมนจริง
3. ตั้ง WAF / Rate limiting rule ของ Cloudflare สำหรับ `/api/v1/auth/*` และ `/api/v1/licenses/*`
4. ทำ Release Checklist ใน [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) ให้ครบ

## 9. Deploy ผ่าน GitHub Actions

* `.github/workflows/ci.yml` รัน typecheck, test, build ทุก PR และทุก push ไป `main`
* `.github/workflows/deploy.yml` รันด้วยมือ (Actions → Deploy → เลือก staging/production) ต้องตั้งค่า:
  * GitHub **Environments** ชื่อ `staging` และ `production` (production ควรตั้ง Required reviewers)
  * Environment secrets: `CLOUDFLARE_API_TOKEN` (สิทธิ์ Workers Scripts:Edit และ D1:Edit เท่านั้น), `CLOUDFLARE_ACCOUNT_ID`
  * Environment variable (ไม่บังคับ): `HEALTH_URL` เช่น `https://license.example.com` เพื่อตรวจ health หลัง deploy
* Worker secrets ไม่ได้อยู่ใน GitHub ตั้งด้วย `wrangler secret put` ตามขั้นตอน 4 เท่านั้น

## 10. ย้อนกลับ (Rollback) และการเปลี่ยนแปลงฐานข้อมูล

* โค้ด: `npx wrangler deployments list --env production` แล้ว `npx wrangler rollback <deployment-id> --env production`
* Migration เป็นแบบเพิ่มอย่างเดียว (additive) เพื่อให้โค้ดรุ่นก่อนยังทำงานกับ schema ใหม่ได้ ก่อนรัน migration ให้จด D1 Time Travel bookmark ทุกครั้ง รายละเอียดการกู้คืนอยู่ใน [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md)

## 11. การหมุนกุญแจลงนาม lease (Key rotation)

1. สร้างคู่กุญแจใหม่ (`generate-dev-secrets.mjs --print` ใช้เฉพาะค่า `LEASE_SIGNING_PRIVATE_JWK`)
2. ตั้ง `LEASE_PREVIOUS_PUBLIC_KEYS` เป็น JSON `[{"kid":"prod-1","jwk":{"kty":"OKP","crv":"Ed25519","x":"<public x ของกุญแจเดิม>"}}]`
3. ตั้ง `LEASE_SIGNING_PRIVATE_JWK` เป็นกุญแจใหม่ และเปลี่ยน `LEASE_SIGNING_KEY_ID` เป็น `prod-2` ใน wrangler.toml แล้ว deploy
4. หลังผ่านไปนานกว่า `LEASE_TTL_SECONDS` (lease เดิมหมดอายุหมดแล้ว) ลบ `LEASE_PREVIOUS_PUBLIC_KEYS`

## 12. การติดตามระบบ

* Workers Logs (เปิด `observability` ไว้แล้ว) หรือ `npx wrangler tail --env production` ข้อความ log เป็น JSON และถูก redact License Key / token แล้ว
* ตั้งการแจ้งเตือนของ Cloudflare สำหรับอัตรา error 5xx
* ตรวจหน้า **Audit** ใน dashboard เป็นประจำ (เช่น `user.locked`, `activation.failed`, `payment.rejected`)
