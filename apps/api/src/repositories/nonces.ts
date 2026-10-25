/** Records a request nonce. Returns false if it was already used (replay). */
export async function claimNonce(db: D1Database, nonceHash: string, expiresAt: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO request_nonces (nonce_hash, expires_at) VALUES (?, ?) ON CONFLICT (nonce_hash) DO NOTHING")
    .bind(nonceHash, expiresAt)
    .run();
  return r.meta.changes === 1;
}

export async function purgeNonces(db: D1Database, nowIso: string) {
  await db.prepare("DELETE FROM request_nonces WHERE expires_at < ?").bind(nowIso).run();
}
