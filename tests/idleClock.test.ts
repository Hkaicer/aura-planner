import { describe, expect, it } from "vitest";
import { idleClock } from "../server/idleClock";

const TICK = 30_000;

describe("idle stop of an icon-started server", () => {
  it("counts the time without any request while the computer is awake", () => {
    let t = 0;
    const clock = idleClock(2 * TICK, () => t);
    let idle = 0;
    for (let i = 0; i < 41; i++) {
      t += TICK;
      idle = clock.tick();
    }
    expect(idle).toBe(41 * TICK);
    expect(idle).toBeGreaterThan(20 * 60_000);
  });

  it("does not count a night of sleep, so the open window can send its heartbeat on wake", () => {
    let t = 0;
    const clock = idleClock(2 * TICK, () => t);
    t += TICK;
    clock.tick();
    t += 10 * 3_600_000; // asleep for 10 hours: the next tick comes late
    expect(clock.tick()).toBe(TICK + 2 * TICK);
    t += 20_000;
    clock.reset(); // heartbeat from the window
    t += TICK;
    expect(clock.tick()).toBe(TICK);
  });

  it("starts again from zero after each request", () => {
    let t = 0;
    const clock = idleClock(2 * TICK, () => t);
    for (let i = 0; i < 30; i++) {
      t += TICK;
      clock.tick();
    }
    clock.reset();
    t += TICK;
    expect(clock.tick()).toBe(TICK);
  });
});
