import { configureLockSlots } from "@knowledge-base/db/lock-slots";
import { describe, expect, it } from "vitest";

// Pool of 3 → two lock slots.
configureLockSlots(3);

const { LockSlotTimeoutError, releaseSlots, tryAcquireSlots, withLockSlot } = await import(
  "./lock-slots"
);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("lock slots", () => {
  it("a holder that reserved a nested slot runs its nested lock transaction without waiting", async () => {
    const order: string[] = [];
    const first = gate();
    // Two holders that each run a nested lock transaction (a password write
    // and its revocation). With 2 slots, holding one each and waiting for a
    // second would deadlock; reserving both up front serializes them.
    const holder = (name: string, wait: Promise<void>) =>
      withLockSlot(
        async () => {
          order.push(`${name}:in`);
          await wait;
          await withLockSlot(async () => {
            order.push(`${name}:nested`);
          });
        },
        { nested: 1 },
      );
    const a = holder("a", first.opened);
    const b = holder("b", Promise.resolve());
    await Promise.resolve();
    expect(order).toEqual(["a:in"]);
    // Both slots are A's: nothing else gets one meanwhile.
    expect(tryAcquireSlots()).toBe(false);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:in", "a:nested", "b:in", "b:nested"]);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("hands slots to waiters in arrival order and never lets a try jump the queue", async () => {
    expect(tryAcquireSlots()).toBe(true);
    const order: string[] = [];
    const pair = withLockSlot(async () => order.push("pair"), { nested: 1 });
    // One slot is free, but the pair waiting for two is first in line.
    expect(tryAcquireSlots()).toBe(false);
    const single = withLockSlot(async () => order.push("single"));
    releaseSlots();
    await Promise.all([pair, single]);
    expect(order).toEqual(["pair", "single"]);
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("a waiter past its deadline leaves the queue and stops holding up the ones behind it", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const order: string[] = [];
    const pair = withLockSlot(async () => order.push("pair"), {
      nested: 1,
      deadline: performance.now() + 50,
    });
    const single = withLockSlot(async () => order.push("single"));
    // One slot frees up, but the pair at the head needs two.
    releaseSlots();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    await expect(pair).rejects.toBeInstanceOf(LockSlotTimeoutError);
    // The expired pair is gone, so the single behind it got the free slot.
    await single;
    expect(order).toEqual(["single"]);
    releaseSlots();
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("a waiter admitted before its deadline runs normally", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const waited = withLockSlot(async () => "ran", { deadline: performance.now() + 1_000 });
    releaseSlots(2);
    await expect(waited).resolves.toBe("ran");
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });
});

it("auth and every DB/API identity writer share the same lock-slot implementation", async () => {
  expect((await import("@knowledge-base/db/lock-slots")).withLockSlot).toBe(withLockSlot);
});
