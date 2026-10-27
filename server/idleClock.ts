/**
 * How long an icon-started server has gone without a request, counting only
 * the time the computer was awake. After sleep, the open window gets the full
 * delay again to send its next heartbeat.
 */
export function idleClock(maxTickGapMs: number, now: () => number = Date.now) {
  let idleMs = 0;
  let last = now();
  return {
    /** A request arrived. */
    reset() {
      idleMs = 0;
      last = now();
    },
    /** Called on a regular timer. Returns the idle time so far, in ms. */
    tick() {
      const t = now();
      // A tick that comes much later than planned means the computer was asleep: that time does not count.
      idleMs += Math.min(t - last, maxTickGapMs);
      last = t;
      return idleMs;
    },
  };
}
