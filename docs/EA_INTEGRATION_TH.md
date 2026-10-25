# คู่มือเชื่อมต่อ EA (MT4/MT5) กับ GTRP License — โปรโตคอล v1

เอกสารนี้สำหรับนักพัฒนา EA และผู้ดูแลระบบ อธิบายวิธีให้ EA ตรวจสิทธิ์กับ License Server, รูปแบบ request/response ที่แน่นอน, การตั้งค่า WebRequest และพฤติกรรมเมื่อเครือข่ายล้มเหลว

ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|---|---|
| `ea-examples/include/GTRPLicense.mqh` | ไลบรารี client ใช้ได้ทั้ง MQL4 และ MQL5 (ไม่ใช้ DLL) |
| `ea-examples/mt4/GTRP_License_Example.mq4` | ตัวอย่าง EA สำหรับ MT4 (ไม่มีกลยุทธ์เทรด) |
| `ea-examples/mt5/GTRP_License_Example.mq5` | ตัวอย่าง EA สำหรับ MT5 (ไม่มีกลยุทธ์เทรด) |
| `ea-examples/reference-client/src/licenseClient.ts` | ต้นแบบ state machine ฉบับ TypeScript ที่รันเทสต์ได้จริง ไฟล์ `.mqh` ทำตามกฎชุดเดียวกัน |

> **ข้อจำกัดที่ต้องรู้:** โค้ด MQL ในโปรเจกต์นี้ยังไม่ได้คอมไพล์ด้วย MetaEditor (สภาพแวดล้อมที่ใช้พัฒนาไม่มี MetaTrader) ต้องคอมไพล์และทดสอบบนบัญชีเดโม่ก่อนใช้จริง ส่วนตรรกะเดียวกันในฉบับ TypeScript ผ่านเทสต์กับ mock API และกับ API จริงแล้ว

---

## 1. ตั้งค่า WebRequest (ต้องทำทุกเครื่อง)

MetaTrader จะไม่ยอมให้ EA เรียก URL ภายนอกจนกว่าจะอนุญาต

1. เปิด MetaTrader → **Tools → Options → Expert Advisors**
2. ติ๊ก **Allow WebRequest for listed URL**
3. กด **Add** แล้วใส่ URL ของ License Server เช่น `https://license.example.com` (ใส่เฉพาะ scheme + โดเมน ไม่ต้องมี path)
4. กด OK แล้วโหลด EA ใหม่

ถ้าลืมตั้งค่า EA จะเขียนใน Experts log ว่า `add https://... to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.` และจะ **ไม่เปิดออเดอร์ใหม่** จนกว่าจะตรวจสิทธิ์ผ่าน (ออเดอร์ที่เปิดอยู่ยังถูกดูแลตามปกติ)

ข้อกำหนด

- ต้องใช้ `https://` เท่านั้น (ตัวอย่าง EA ปฏิเสธ `http://`)
- WebRequest ใช้ไม่ได้ใน Strategy Tester ตัวอย่าง EA จึงข้ามการตรวจสิทธิ์ในโหมด Tester (ใช้ได้เฉพาะ backtest ไม่มีผลกับบัญชีจริง)
- WebRequest เรียกจาก Indicator ไม่ได้ ต้องเรียกจาก EA เท่านั้น

## 2. ติดตั้งตัวอย่าง

1. คัดลอก `GTRPLicense.mqh` ไปที่ `<Data Folder>/MQL4/Include/` หรือ `<Data Folder>/MQL5/Include/` (เปิด Data Folder ได้จาก File → Open Data Folder)
2. คัดลอกไฟล์ `.mq4` / `.mq5` ไปที่ `MQL4/Experts/` หรือ `MQL5/Experts/`
3. คอมไพล์ใน MetaEditor
4. ลาก EA ลงชาร์ต ใส่ `InpLicenseKey` และ `InpLicenseServer`

การผูก EA ของคุณเอง: ย้ายโค้ดดูแลออเดอร์ไปไว้ใน `ManageOpenPositions()` (ทำงานทุก tick เสมอ) และเงื่อนไขเปิดออเดอร์ไว้หลัง `g_license.CanOpenNewPositions()`

## 3. ข้อมูลที่ EA ส่ง (ส่งเท่าที่จำเป็น)

| ฟิลด์ | ที่มา | หมายเหตุ |
|---|---|---|
| `license_key` | input ของผู้ใช้ | ส่งใน body เท่านั้น ห้ามใส่ใน URL ห้าม Print |
| `product` | ค่าคงที่ใน EA เช่น `gtrp_ea` | ต้องตรงกับ `ea_products` ของแพ็กเกจ |
| `platform` | `mt4` หรือ `mt5` ตามคอมไพเลอร์ | |
| `activation_id` | สุ่มครั้งแรกแล้วเก็บไฟล์ `MQLx/Files/GTRP/activation_mtX.id` | เป็นตัวระบุการติดตั้ง ไม่ใช่ fingerprint ฮาร์ดแวร์ เซิร์ฟเวอร์เก็บเป็น hash |
| `account_ref` | `AccountServer:AccountLogin` | **ส่งเฉพาะเมื่อแพ็กเกจกำหนดให้ผูกบัญชี** (เซิร์ฟเวอร์ตอบ `ACCOUNT_REF_REQUIRED` แล้ว EA ส่งซ้ำพร้อมค่านี้) เซิร์ฟเวอร์เก็บเป็น hash |
| `request_id` | UUID ใหม่ทุกครั้ง | กัน replay ห้ามใช้ซ้ำ |
| `client_time` | `TimeGMT()` + offset จากเซิร์ฟเวอร์ | ตรวจนาฬิกาเพี้ยน |
| `protocol_version` | `1` | |

EA **ไม่ส่ง** รหัสผ่านโบรกเกอร์ รหัส investor หรือข้อมูลถอนเงินใด ๆ ทั้งสิ้น

## 4. Endpoint และรูปแบบข้อมูลที่แน่นอน

ทุก endpoint เป็น `POST`, `Content-Type: application/json`, ขนาด body ไม่เกิน 64 KB

### 4.1 `POST /api/v1/licenses/activate`

เรียกเมื่อ EA เริ่มทำงาน ถ้าการติดตั้งนี้เคย activate แล้วจะไม่กินโควตาเพิ่ม (idempotent)

Request

```json
{
  "protocol_version": 1,
  "request_id": "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f",
  "client_time": "2026-10-25T10:41:05Z",
  "license_key": "GTRP-XXXX-XXXX-XXXX-XXXX",
  "product": "gtrp_ea",
  "platform": "mt5",
  "activation_id": "mt5_3f9a1c0b7d2e4f6a8b1c2d3e",
  "account_ref": "BrokerServer-Live:12345678",
  "label": "VPS-1"
}
```

| ฟิลด์ | ชนิด | บังคับ | กฎ |
|---|---|---|---|
| `protocol_version` | integer | ใช่ | ปัจจุบันรองรับ `1` |
| `request_id` | string (UUID) | ใช่ | ไม่ซ้ำภายใน 10 นาที |
| `client_time` | string ISO 8601 ลงท้าย `Z` | ใช่ | ต่างจากเวลาเซิร์ฟเวอร์ไม่เกิน 300 วินาที |
| `license_key` | string | ใช่ (EA) | รูปแบบ `GTRP-XXXX-XXXX-XXXX-XXXX` ตัวพิมพ์เล็ก/ใหญ่ได้ |
| `product` | string `^[a-z][a-z0-9_]{2,39}$` | ใช่ | |
| `platform` | `"mt4"` \| `"mt5"` | ใช่ | (`"web"` ใช้กับ Web App) |
| `activation_id` | string `^[A-Za-z0-9_-]{16,128}$` | ใช่ | |
| `account_ref` | string `^[A-Za-z0-9._:@-]{1,96}$` | เมื่อแพ็กเกจผูกบัญชี | |
| `label` | string ≤ 64 | ไม่ | ชื่อที่แอดมินเห็น |

ฟิลด์อื่นนอกจากนี้จะถูกปฏิเสธด้วย `VALIDATION_FAILED`

Response 200 (ตัวอย่างจริงจากเซิร์ฟเวอร์ dev, token ตัดให้สั้น)

```json
{
  "protocol_version": 1,
  "request_id": "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f",
  "server_time": "2026-10-25T10:41:05.120Z",
  "result": "ok",
  "license": {
    "id": "ad289254-32e9-4ac5-9f63-30d08ddd4ed3",
    "status": "active",
    "in_grace": false,
    "plan_code": "QUANT_AUTO",
    "expires_at": "2026-11-25T10:41:05.049Z",
    "grace_until": "2026-11-28T10:41:05.049Z"
  },
  "activation": { "id": "271f5b8c-4239-4e47-b22e-a3ee9117bdfb", "platform": "mt5", "status": "active" },
  "entitlements": {
    "web_access": true,
    "features": ["advanced_charts", "ea_connector", "smc", "volume_analysis"],
    "ea_products": ["gtrp_ea"],
    "ea_platforms": ["mt4", "mt5"],
    "require_account_binding": true
  },
  "lease": { "token": "eyJhbGciOiJFZERTQSIs...", "expires_at": "2026-10-26T10:41:05.000Z" },
  "policy": { "revalidate_after_seconds": 1800, "offline_grace_until": "2026-10-26T10:41:05.000Z" }
}
```

| ฟิลด์ | ความหมาย |
|---|---|
| `request_id` | ต้องเท่ากับที่ส่งไป ถ้าไม่ตรง ให้ถือว่า response เสีย (transient) |
| `server_time` | เวลา UTC ของเซิร์ฟเวอร์ ใช้คำนวณ offset นาฬิกา |
| `license.status` | `active` เสมอเมื่อสำเร็จ; `in_grace: true` = หมดอายุแล้วแต่อยู่ในช่วงผ่อนผันต่ออายุ |
| `lease.token` | License Lease ที่เซ็นด้วย Ed25519 (ดูข้อ 6) |
| `policy.revalidate_after_seconds` | ควรตรวจใหม่หลังจากนี้ (ค่าเริ่มต้น 1800) |
| `policy.offline_grace_until` | เวลาสุดท้ายที่ EA ยังเปิดออเดอร์ใหม่ได้ถ้าติดต่อเซิร์ฟเวอร์ไม่ได้ (= `lease.expires_at`, ไม่เกิน 24 ชม. และไม่เกินวันหมดสิทธิ์ของ License) |

### 4.2 `POST /api/v1/licenses/validate`

เหมือน activate แต่ไม่มี `label` และ **ไม่สร้าง** activation ใหม่ ถ้าการติดตั้งยังไม่เคย activate จะได้ `404 ACTIVATION_NOT_FOUND` (client ตัวอย่างจะ activate ใหม่อัตโนมัติ)

### 4.3 `POST /api/v1/licenses/refresh`

ต่ออายุ lease โดยไม่ต้องส่ง license key ซ้ำ เซิร์ฟเวอร์ตรวจสถานะ License ใหม่ทุกครั้ง

```json
{
  "protocol_version": 1,
  "request_id": "0b0c1d2e-3f40-4152-8364-758697a8b9ca",
  "client_time": "2026-10-25T11:11:05Z",
  "lease_token": "eyJhbGciOiJFZERTQSIs...",
  "activation_id": "mt5_3f9a1c0b7d2e4f6a8b1c2d3e"
}
```

Response 200 รูปแบบเดียวกับ activate ถ้า lease หมดอายุหรือไม่ถูกต้องจะได้ `401 LEASE_EXPIRED` / `401 LEASE_INVALID` ให้กลับไปใช้ validate ด้วย key

### 4.4 `POST /api/v1/licenses/deactivate`

คืนโควตาของการติดตั้งนี้ (เช่น ย้าย VPS) ทำได้ทุกสถานะของ License

```json
{
  "protocol_version": 1,
  "request_id": "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  "client_time": "2026-10-25T12:00:00Z",
  "license_key": "GTRP-XXXX-XXXX-XXXX-XXXX",
  "platform": "mt5",
  "activation_id": "mt5_3f9a1c0b7d2e4f6a8b1c2d3e"
}
```

```json
{ "protocol_version": 1, "request_id": "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", "server_time": "2026-10-25T12:00:00.354Z", "result": "deactivated" }
```

ตัวอย่าง EA เรียก deactivate เฉพาะเมื่อผู้ใช้ถอด EA ออกจากชาร์ตเอง (`REASON_REMOVE`) ไม่เรียกตอนเปลี่ยน timeframe หรือปิดโปรแกรม

### 4.5 รูปแบบ Error (ทุก endpoint)

```json
{
  "error": {
    "code": "LICENSE_INVALID",
    "message": "The license key is not valid.",
    "request_id": "072574c6-1f61-4919-acea-6eeca42f084a",
    "retryable": false,
    "server_time": "2026-10-25T10:41:05.299Z"
  }
}
```

`error.request_id` คือรหัสอ้างอิงฝั่งเซิร์ฟเวอร์ (ใช้แจ้งทีมซัพพอร์ต) ไม่ใช่ `request_id` ที่ EA ส่งไป

## 5. ตาราง error และสิ่งที่ EA ต้องทำ

**การปฏิเสธที่ยืนยันแล้ว (confirmed denial)** — หยุดเปิดออเดอร์ใหม่ทันที แต่ยังดูแลออเดอร์เดิม และตรวจซ้ำทุก 15 นาที (ถ้าแอดมินเปิดสิทธิ์คืน EA จะกลับมาทำงานเอง)

| HTTP | code | ความหมาย |
|---|---|---|
| 403 | `LICENSE_INVALID` | key ไม่ถูกต้อง/ไม่มีอยู่/ถูก reissue แล้ว |
| 403 | `LICENSE_NOT_STARTED` | ยังไม่ถึงวันเริ่ม |
| 403 | `LICENSE_NOT_ACTIVE` | License ยังอยู่สถานะ created (เช่น รอชำระเงิน) |
| 403 | `LICENSE_EXPIRED` | หมดอายุและพ้นช่วงผ่อนผัน |
| 403 | `LICENSE_SUSPENDED` | ถูกระงับ (License หรือบัญชีลูกค้า) |
| 403 | `LICENSE_REVOKED` | ถูกเพิกถอนถาวร |
| 403 | `PRODUCT_NOT_ENTITLED` | แพ็กเกจไม่รวม EA ตัวนี้ |
| 403 | `PLATFORM_NOT_ENTITLED` | แพ็กเกจไม่รวม MT4/MT5 นี้ |
| 409 | `ACTIVATION_LIMIT_REACHED` | ใช้ครบจำนวนติดตั้ง EA แล้ว |
| 409 | `ACCOUNT_LIMIT_REACHED` | ใช้ครบจำนวนบัญชีเทรดแล้ว |
| 403 | `ACCOUNT_REF_REQUIRED` | แพ็กเกจต้องผูกบัญชี (client ส่งซ้ำพร้อม `account_ref` อัตโนมัติ 1 ครั้ง) |
| 409 | `ACCOUNT_MISMATCH` | การติดตั้งนี้ผูกกับบัญชีอื่น ต้อง deactivate ก่อน |
| 404 | `ACTIVATION_NOT_FOUND` | ยังไม่ได้ activate (client activate ใหม่อัตโนมัติ) |
| 403 | `ACTIVATION_REVOKED` | แอดมินรีเซ็ตหรือผู้ใช้ deactivate การติดตั้งนี้ ให้รีสตาร์ต EA เพื่อ activate ใหม่ (ถ้ายังมีโควตา) |

**ความล้มเหลวชั่วคราว (transient)** — ห้ามตีความว่าถูกเพิกถอน ใช้ lease เดิมต่อจนถึง `offline_grace_until`

| สาเหตุ | สิ่งที่ EA ทำ |
|---|---|
| WebRequest คืน -1 (timeout 5 วิ, DNS, TLS, ยังไม่อนุญาต URL) | `NETWORK` / `WEBREQUEST_NOT_ALLOWED` → offline grace, retry 60 วิ แล้วเพิ่มเป็น 2 เท่าจนสูงสุด 15 นาที |
| HTTP 5xx, `INTERNAL_ERROR` | เหมือนข้างบน |
| HTTP 429 `RATE_LIMITED` | เหมือนข้างบน (ดู header `Retry-After`) |
| 400 `CLOCK_SKEW` | ตั้ง offset = `error.server_time` − `TimeGMT()` แล้วส่งใหม่ 1 ครั้ง |
| 409 `REPLAY_DETECTED` | สร้าง `request_id` ใหม่ในรอบถัดไป |
| 400 `UNSUPPORTED_PROTOCOL` / `VALIDATION_FAILED` | ข้อผิดพลาดของ EA เอง แจ้งผู้พัฒนา |
| 401 `LEASE_INVALID` / `LEASE_EXPIRED` (refresh) | ทิ้ง lease แล้ว validate ด้วย key |
| body ไม่ใช่ JSON (เช่น หน้า captive portal), `request_id` ไม่ตรง, ไม่มี `lease.token` | `MALFORMED` → transient |

## 6. State machine ของ EA

```
            activate ok                    refresh/validate ok
 UNKNOWN ─────────────────► VALID ◄───────────────────────────────┐
    │                         │  transient error                  │
    │ transient               ▼                                   │
    │ (ห้ามเปิดออเดอร์)     OFFLINE_GRACE ── ok ──────────────────┤
    │                         │  เลย offline_grace_until           │
    │                         ▼                                   │
    │                       LAPSED (หยุดเปิดออเดอร์ใหม่) ─ ok ─────┤
    │                                                             │
    └──── confirmed denial ──► DENIED (หยุดเปิดออเดอร์ใหม่) ─ ok ──┘
```

| สถานะ | เปิดออเดอร์ใหม่ | ดูแล/ปิดออเดอร์เดิม |
|---|---|---|
| UNKNOWN (ยังไม่เคยตรวจผ่านในรอบนี้) | ไม่ได้ | ได้ |
| VALID | ได้ | ได้ |
| OFFLINE_GRACE | ได้ จนถึง `offline_grace_until` | ได้ |
| LAPSED | ไม่ได้ | ได้ |
| DENIED | ไม่ได้ | ได้ |

กฎสำคัญ

- **ไม่เคยบล็อกการจัดการออเดอร์เดิม** (stop-loss, take-profit, trailing, ปิดออเดอร์) ไม่ว่า API จะล่มหรือ License ถูกระงับ
- offline grace มีขอบเขต: ไม่เกินอายุ lease (ค่าเริ่มต้น 24 ชม.) ไม่เกินวันหมดสิทธิ์ของ License และ client ตัดที่ 7 วันเสมอแม้ response จะบอกนานกว่า
- lease เก็บในหน่วยความจำเท่านั้น รีสตาร์ต terminal ขณะออฟไลน์จะกลับไปสถานะ UNKNOWN (ปลอดภัยกว่าการเก็บไฟล์ที่แก้ไขได้)
- นาฬิกา: เปรียบเทียบเวลาด้วย `TimeGMT() + offset` ที่ได้จาก `server_time` เสมอ

## 7. License Lease และข้อจำกัดด้านความปลอดภัย

Lease เป็น compact JWS: `base64url(header).base64url(payload).base64url(signature)`

- header: `{"alg":"EdDSA","typ":"GTRP-LEASE","kid":"prod-1"}`
- payload: `iss`, `v` (protocol), `jti` (UUID), `sub` (license id), `act` (activation id), `product`, `platform`, `ent` (`features`, `ea_products`), `iat`, `exp` (วินาที UTC)
- กุญแจสาธารณะสำหรับตรวจ: `GET /api/v1/lease/public-keys`
- private key อยู่ใน Cloudflare Secret เท่านั้น ไม่มีใน EA

**ข้อจำกัด:** MQL4/MQL5 ไม่มีฟังก์ชัน Ed25519 ในตัว และเราไม่ใช้ DLL ดังนั้น EA ตัวอย่าง **ไม่ได้ตรวจลายเซ็น lease** แต่อาศัย HTTPS (ตรวจใบรับรองโดย WinINet ของ MetaTrader) และเซิร์ฟเวอร์ตรวจลายเซ็นตอน refresh แทน Web App และระบบฝั่งเซิร์ฟเวอร์อื่นตรวจลายเซ็นได้ด้วย `verifyLease()` ใน `@gtrp/shared`

ไม่มีระบบ client ใดป้องกันการแก้ไขไฟล์ EA ได้ 100% (เช่น decompile แล้วตัดการตรวจสิทธิ์ออก) มาตรการของระบบนี้คือ ควบคุมสิทธิ์ที่เซิร์ฟเวอร์ จำกัดจำนวนติดตั้ง/บัญชี ตรวจซ้ำเป็นระยะ และบันทึก audit เพื่อให้ตรวจจับการใช้ผิดปกติได้

## 8. ทดสอบ

```bash
# ตรรกะ client กับ mock License API (timeout, 5xx, HTML, revoke, offline grace, clock skew ...)
pnpm --filter @gtrp/ea-reference-client test

# client ตัวเดียวกันกับ Worker จริง (D1 ภายในเครื่อง)
pnpm --filter @gtrp/api test -- ea-conformance
```

เช็กลิสต์ทดสอบบน MetaTrader (บัญชีเดโม่) ก่อนปล่อยจริง

- [ ] คอมไพล์ `.mq4` และ `.mq5` ผ่านโดยไม่มี warning ร้ายแรง
- [ ] ไม่ตั้ง WebRequest → เห็นข้อความแนะนำใน Experts log, ไม่เปิดออเดอร์ใหม่
- [ ] key ถูกต้อง → Comment แสดง `License OK`
- [ ] ปิดเน็ต → `License server unreachable ... Offline until ...` ออเดอร์เดิมยังถูกดูแล
- [ ] แอดมิน Suspend → ภายใน 30 นาทีขึ้น `License denied: LICENSE_SUSPENDED`
- [ ] แอดมิน Reactivate → กลับเป็น `License OK` ภายใน 15 นาที
- [ ] ถอด EA ออกจากชาร์ต → แอดมินเห็น activation เป็น revoked
- [ ] Experts log ไม่มี license key ปรากฏ
