import { useState } from "react";
import { Modal } from "./Modal";

/** Shows a newly issued license key exactly once. The server keeps only a hash, so it cannot be shown again. */
export function KeyReveal({ licenseKey, onClose }: { licenseKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title="License key issued"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          I have saved the key
        </button>
      }
    >
      <p>
        <strong>This is the only time the full key is shown.</strong> Send it to the customer through a private channel. Do not paste it into chat groups or tickets.
      </p>
      <div className="key-box">
        <code data-testid="license-key">{licenseKey}</code>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(licenseKey);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Modal>
  );
}
