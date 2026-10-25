-- GTRP License System - payments: refund/chargeback idempotency anchor.
-- Records which provider event moved a payment to "refunded", so the webhook
-- handler can make "refund applied" and "event recorded" one atomic step.
ALTER TABLE payments ADD COLUMN refund_event_id TEXT;
