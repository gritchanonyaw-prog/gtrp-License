import type { Transport } from "./licenseClient.js";

/** HTTPS transport with a hard timeout, equivalent to MQL WebRequest(..., timeout, ...). */
export const fetchTransport: Transport = async (url, body, timeoutMs) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
};
