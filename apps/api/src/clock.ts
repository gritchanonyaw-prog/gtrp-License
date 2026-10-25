/**
 * Single source of server time (UTC). Tests may override `clock.nowMs`
 * to simulate expiry and clock skew without touching global timers.
 */
export const clock = {
  nowMs: (): number => Date.now(),
};

export function nowIso(): string {
  return new Date(clock.nowMs()).toISOString();
}

export function isoPlusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
