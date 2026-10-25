-- Manual rollback of 0002. Not applied by wrangler; run only after a backup (see docs/BACKUP_RECOVERY.md).
ALTER TABLE payments DROP COLUMN refund_event_id;
