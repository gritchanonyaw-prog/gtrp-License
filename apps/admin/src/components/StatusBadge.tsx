const TONES: Record<string, string> = {
  active: "ok",
  paid: "ok",
  created: "info",
  pending: "info",
  not_started: "info",
  expired: "warn",
  suspended: "warn",
  failed: "bad",
  revoked: "bad",
  refunded: "bad",
  deleted: "bad",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge badge-${TONES[status] ?? "info"}`}>{label ?? status.replace("_", " ")}</span>;
}
