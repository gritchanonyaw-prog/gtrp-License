import { useState, type ReactNode } from "react";
import { errorMessage } from "./States";
import { Modal } from "./Modal";

/**
 * Confirmation for destructive or sensitive actions. When `requireReason` is set the
 * operator must type a reason (stored in the audit log) before the action runs.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  requireReason = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = !requireReason || reason.trim().length >= 3;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={run} disabled={!valid || busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div>{message}</div>
      {requireReason && (
        <label className="field">
          <span>Reason (saved in the audit log)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required aria-required="true" />
        </label>
      )}
      {error !== null && (
        <p className="error-text" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </Modal>
  );
}
