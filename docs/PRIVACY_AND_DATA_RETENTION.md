# Privacy and data retention

> **Status: template for legal review.** This document describes what the software collects and how long it keeps it, and provides a Thai privacy notice draft. It is **not** legal advice and does not claim compliance with the Personal Data Protection Act B.E. 2562 (PDPA) or any other law. Have a qualified lawyer review and complete it before collecting customer data.

## Part A: Data inventory (technical, maintained by the developers)

| Data | Where | Form | Purpose | Default retention |
| --- | --- | --- | --- | --- |
| Email | `users.email` | plaintext (needed for login and contact) | account, support, license delivery | until account deletion, then replaced by `deleted+<id>@invalid.local` |
| Password | `users.password_hash` | PBKDF2 hash | authentication | until deletion (set to NULL) |
| Admin TOTP secret | `users.mfa_secret_enc` | AES-GCM encrypted | admin MFA | until deletion |
| Session | `sessions` | SHA-256 of token, expiry, timestamps | stay signed in | rows purged 30 days after their expiry time (revoked sessions stop working immediately) |
| License key | `licenses.key_hash`, `key_hint` | HMAC hash + last 4 chars | license verification | life of the license; key hash cleared on account deletion |
| EA/browser installation id | `activations.device_hash` | HMAC hash of a random client-generated id (not a hardware fingerprint) | enforce device limits | life of the license (revoked rows kept for audit) |
| Device label | `activations.label` | plaintext chosen by user (e.g. "VPS-1") | help the user recognize devices | cleared on account deletion |
| Trading account reference | `activations.account_ref_hash` | HMAC hash, **only** if the plan binds accounts | enforce trading-account limit | cleared on account deletion |
| Payment records | `payments` | amount, currency, status, provider reference; **no card data** | billing, refunds, accounting | per accounting/tax law (fill in, commonly 5–10 years) |
| Webhook records | `payment_events` | event id, type, SHA-256 of payload (payload not stored) | idempotency, dispute evidence | same as payments |
| Audit events | `license_events` | actor, action, target, redacted details | security, dispute resolution | indefinitely by default (append-only); define a period below |
| Rate-limit counters | `api_rate_limits` | truncated keyed hash of IP/user + count | abuse prevention | purged after ~2 hours |
| Request nonces | `request_nonces` | keyed hash of request id | replay protection | purged after expiry (minutes) |
| Server logs | Cloudflare Workers Logs | JSON, keys/tokens redacted, no IP stored by the app | operations | per Cloudflare plan setting |

Not collected: broker passwords, investor passwords, withdrawal credentials, trade history, balances, card numbers, hardware fingerprints, raw IP addresses in the database.

### Deletion workflow

* Customer self-service: `POST /api/v1/me/delete` (password required).
* Admin: Customers → Delete account (reason required, audited).
* Effect (one transaction): sessions revoked; licenses revoked and key hashes cleared; activations revoked with labels and account hashes cleared; email replaced, password and MFA cleared; `status = deleted`. Audit events remain but point to an anonymized account.
* Retained after deletion: payment rows (accounting obligation) and audit events. Document the legal basis for each below.
* Backups/exports: deleted data persists in D1 Time Travel up to its retention window and in exports until they expire. State this in the notice.

### Configuration points

* Session purge age and nonce/rate-limit purge are in `apps/api/src/services/maintenance.ts`.
* Audit and payment retention are not purged automatically. If the legal review sets a period, add a purge step to the maintenance job and document it here.
* Account binding (collecting trading account references) is off unless a plan enables `require_account_binding`.

### Data exports by administrators

There is no bulk export feature in the dashboard. Database exports (`wrangler d1 export`) are an operator procedure covered by BACKUP_RECOVERY.md and must be encrypted and access-restricted.

## Part B: Thai privacy notice draft (ร่างประกาศความเป็นส่วนตัว สำหรับให้ทนายความตรวจ)

> ข้อความในวงเล็บเหลี่ยม `[ ]` ต้องกรอกหรือยืนยันโดยผู้ควบคุมข้อมูลและที่ปรึกษากฎหมาย

**ประกาศความเป็นส่วนตัวของระบบ License GTRP**

ปรับปรุงล่าสุด: [วันที่]

**1. ผู้ควบคุมข้อมูลส่วนบุคคล**
[ชื่อนิติบุคคล/บุคคล] ที่อยู่ [ที่อยู่] อีเมลติดต่อ [อีเมล] เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล (ถ้ามี) [ชื่อ/ช่องทางติดต่อ]

**2. ข้อมูลที่เราเก็บ**
* ข้อมูลบัญชี: อีเมล และรหัสผ่าน (เก็บในรูปแบบที่ไม่สามารถถอดกลับได้)
* ข้อมูลการใช้สิทธิ์: รหัสการติดตั้งที่สุ่มขึ้นโดยโปรแกรม (เก็บเป็นค่า hash) ชื่อเครื่องที่ท่านตั้งเอง ประเภทแพลตฟอร์ม (Web/MT4/MT5) และเวลาที่ใช้งานล่าสุด
* หมายเลขบัญชีเทรดและชื่อเซิร์ฟเวอร์โบรกเกอร์ เฉพาะเมื่อแผนบริการของท่านกำหนดให้ผูกบัญชี (เก็บเป็นค่า hash)
* ข้อมูลการชำระเงิน: จำนวนเงิน สกุลเงิน สถานะ และเลขอ้างอิงจากผู้ให้บริการชำระเงิน (เราไม่เก็บข้อมูลบัตร)
* บันทึกเหตุการณ์ด้านความปลอดภัยและการเปลี่ยนแปลงสิทธิ์

เราไม่เก็บรหัสผ่านโบรกเกอร์ รหัสผ่านนักลงทุน ข้อมูลการถอนเงิน ประวัติการเทรด หรือยอดเงินในบัญชีของท่าน

**3. วัตถุประสงค์และฐานทางกฎหมาย**
| วัตถุประสงค์ | ฐานทางกฎหมาย [ให้ทนายยืนยัน] |
| --- | --- |
| ให้บริการและตรวจสอบสิทธิ์การใช้งาน Web App และ EA | การปฏิบัติตามสัญญา |
| ป้องกันการใช้งานเกินสิทธิ์ การทุจริต และรักษาความปลอดภัยระบบ | ประโยชน์โดยชอบด้วยกฎหมาย |
| ออกใบเสร็จ การบัญชี และภาษี | หน้าที่ตามกฎหมาย |
| ติดต่อเรื่องบริการ | การปฏิบัติตามสัญญา |

**4. ระยะเวลาการเก็บรักษา**
* ข้อมูลบัญชีและการใช้สิทธิ์: ตลอดระยะเวลาที่มีบัญชี และลบหรือทำให้ไม่สามารถระบุตัวตนได้เมื่อมีการลบบัญชี
* ข้อมูลการชำระเงิน: [ระยะเวลาตามกฎหมายบัญชี/ภาษี]
* บันทึกความปลอดภัย: [ระยะเวลา]
* ข้อมูลสำรอง (backup): ไม่เกิน [30 วัน / ระยะเวลาที่กำหนด] หลังการลบ

**5. การเปิดเผยข้อมูล**
ผู้ประมวลผลข้อมูลที่เราใช้: Cloudflare, Inc. (โฮสต์ระบบและฐานข้อมูล) [ผู้ให้บริการชำระเงิน] [ผู้ให้บริการอีเมล] ข้อมูลอาจถูกประมวลผลนอกประเทศไทย [ระบุมาตรการคุ้มครองการส่งข้อมูลข้ามประเทศ]

**6. สิทธิของเจ้าของข้อมูล**
ท่านมีสิทธิขอเข้าถึง ขอสำเนา ขอแก้ไข ขอลบ ขอระงับการใช้ คัดค้าน และขอให้โอนย้ายข้อมูล ตามที่กฎหมายกำหนด ท่านสามารถลบบัญชีได้เองในหน้าบัญชี หรือติดต่อ [ช่องทาง] เราจะตอบภายใน [30 วัน] และท่านมีสิทธิร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล

**7. ความปลอดภัย**
เราเข้ารหัสการรับส่งข้อมูลด้วย HTTPS เก็บรหัสผ่าน License Key และรหัสอุปกรณ์ในรูปแบบ hash จำกัดสิทธิ์ผู้ดูแลด้วยการยืนยันตัวตนสองชั้น และบันทึกการเปลี่ยนแปลงที่สำคัญ อย่างไรก็ตามไม่มีระบบใดปลอดภัยสมบูรณ์

**8. การเปลี่ยนแปลงประกาศ**
เราจะแจ้งการเปลี่ยนแปลงที่มีนัยสำคัญผ่าน [ช่องทาง]

## Part C: Open items for the legal review

- [ ] Confirm the controller entity and contact details.
- [ ] Confirm the lawful basis for each purpose, especially account binding and security logging.
- [ ] Decide retention periods for payments, audit events, logs and exports; implement purges if needed.
- [ ] Assess whether installation ids/account references are personal data in this context and whether consent is needed for any of them.
- [ ] Records of processing activities, processor agreements (Cloudflare DPA, payment provider), cross-border transfer basis.
- [ ] Breach notification procedure (72-hour timeline under PDPA) and who executes it.
- [ ] Terms of service covering license sharing, suspension, and refunds.
