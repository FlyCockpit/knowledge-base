import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lock slots: at most this many transactions in this process hold (or wait
 * for) an advisory lock at once (password-write, global identity authority
 * and credential-setup/bootstrap: see auth/password-write-lock.ts,
 * password-reset-links.ts and bootstrap.ts). Each pins a pooled connection
 * while the work it protects (a Better-Auth handler, an insert) needs another, so if lock
 * transactions could fill the pool, nothing would make progress until a
 * timeout. Capping them one below the pool size always leaves a connection
 * for that work.
 *
 * A holder that will itself run a nested lock transaction (a password write
 * runs the credential revocation inside its handler) reserves the nested slot
 * up front, together with its own, so its children never wait globally
 * behind slots held by their own parent. That is why `DATABASE_POOL_MAX` is at least 3.
 */
// Safe before a lazy pool factory runs, including inside the first admitted
// callback. All participating pools must have at least three connections.
let lockSlots = 2;
let configuredPoolMax: number | undefined;
/**
 * Configure admission at the pool construction boundary, using the same max
 * passed to the adapter. One process-wide queue requires matching pool sizes:
 * repeated matching configuration is harmless, but replacing an existing
 * budget could over-admit another live pool or shrink active reservations.
 * First configuration only expands the conservative two-slot budget.
 */
export function configureLockSlots(poolMax: number): void {
  if (!Number.isSafeInteger(poolMax) || poolMax < 3) {
    throw new Error("Lock slots require an integer pool max of at least 3.");
  }
  if (configuredPoolMax !== undefined && configuredPoolMax !== poolMax) {
    throw new Error("Lock slots already configured for a different pool max.");
  }
  configuredPoolMax = poolMax;
  lockSlots = poolMax - 1;
  admitWaiters();
}
let slotsInUse = 0;
type Reservation = {
  capacity: number;
  spare: number;
  active: boolean;
  valid: boolean;
  parent?: Reservation;
  children: Set<Reservation>;
  waiters: SlotWaiter[];
};
type SlotWaiter = {
  count: number;
  reservation?: Reservation;
  resolve: (reservation: Reservation | undefined) => void;
};
const slotWaiters: SlotWaiter[] = [];

/** Take `count` slots now, or answer false (never jumps the queue). */
export function tryAcquireSlots(count = 1): boolean {
  if (slotWaiters.length > 0 || slotsInUse + count > lockSlots) return false;
  slotsInUse += count;
  return true;
}

/** Hand free slots to waiters in arrival order. */
function admitWaiters(): void {
  for (let next = slotWaiters[0]; next; next = slotWaiters[0]) {
    if (slotsInUse + next.count > lockSlots) break;
    slotWaiters.shift();
    slotsInUse += next.count;
    next.resolve(undefined);
  }
}

/** Give `count` slots back, handing them to waiters in arrival order. */
export function releaseSlots(count = 1): void {
  slotsInUse -= count;
  admitWaiters();
}

/** No lock slot came free before the caller's deadline. */
export class LockSlotTimeoutError extends Error {
  constructor() {
    super("No lock slot came free before the deadline.");
    this.name = "LockSlotTimeoutError";
  }
}

/**
 * Wait in line for `count` slots. With a `deadline` (a `performance.now()`
 * timestamp), a waiter still queued then leaves the queue (so it no longer
 * holds up the ones behind it) and the wait rejects with
 * {@link LockSlotTimeoutError}.
 */
function waitForSlots(
  count: number,
  deadline: number | undefined,
  reservation?: Reservation,
): Promise<Reservation | undefined> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const waiter: SlotWaiter = {
      count,
      reservation,
      resolve: (source) => {
        clearTimeout(timer);
        resolve(source);
      },
    };
    (reservation?.waiters ?? slotWaiters).push(waiter);
    if (deadline === undefined) return;
    timer = setTimeout(
      () => {
        // A closed reservation moves its queued children into the global FIFO.
        const queue = waiter.reservation?.waiters ?? slotWaiters;
        const at = queue.indexOf(waiter);
        if (at < 0) return; // already admitted
        queue.splice(at, 1);
        if (waiter.reservation) admitReservedWaiters(waiter.reservation);
        else admitWaiters();
        reject(new LockSlotTimeoutError());
      },
      Math.max(0, deadline - performance.now()),
    );
  });
}

/** Slots a holder reserved for its children; siblings compete in arrival order. */
const reservedFor = new AsyncLocalStorage<Reservation>();

function admitReservedWaiters(reservation: Reservation): void {
  for (let next = reservation.waiters[0]; next; next = reservation.waiters[0]) {
    if (next.count > reservation.spare) break;
    reservation.waiters.shift();
    reservation.spare -= next.count;
    next.resolve(reservation);
  }
}

function invalidateReservation(reservation: Reservation): void {
  reservation.valid = false;
  for (const waiter of reservation.waiters) {
    waiter.reservation = undefined;
    slotWaiters.push(waiter);
  }
  reservation.waiters.length = 0;
  // An ancestor's exit invalidates still-active children too. Their idle
  // spares can no longer be borrowed locally, so return them immediately;
  // only work already admitted remains charged until it actually finishes.
  if (reservation.active && reservation.spare > 0) {
    const idle = reservation.spare;
    reservation.spare = 0;
    returnSlots(reservation.parent, idle);
  }
  for (const child of reservation.children) invalidateReservation(child);
}

/** Return only slots whose work finished, even if an ancestor already exited. */
function returnSlots(reservation: Reservation | undefined, count: number): void {
  if (!reservation) {
    releaseSlots(count);
  } else if (reservation.active && reservation.valid) {
    reservation.spare += count;
    if (reservation.valid) admitReservedWaiters(reservation);
  } else {
    returnSlots(reservation.parent, count);
  }
}

/**
 * Run an advisory-lock transaction in a slot, waiting in memory before checkout.
 * `nested` prepays extra slots for children; competing children use that
 * reservation's FIFO rather than waiting globally behind their own holder.
 * A child must fit the reservation (including its own `nested` slots), otherwise
 * it fails closed before checkout. Each child's scope has only its own spares.
 *
 * `deadline` bounds admission, including reservation-local waits. When a holder
 * exits, its reservation and tickets expire for future descendants. Queued
 * children join the global FIFO with their original deadlines; active children
 * keep their slots charged until they finish, even after their ancestors exit.
 */
export async function withLockSlot<T>(
  fn: () => Promise<T>,
  { nested = 0, deadline }: { nested?: number; deadline?: number } = {},
): Promise<T> {
  const count = 1 + nested;
  if (!Number.isInteger(nested) || nested < 0 || count > lockSlots)
    throw new RangeError("Lock slot request exceeds the available reservation.");
  if (deadline !== undefined && deadline <= performance.now()) throw new LockSlotTimeoutError();
  let parent = reservedFor.getStore();
  if (parent?.valid) {
    if (count > parent.capacity)
      throw new RangeError("Nested lock slot request exceeds the outer reservation.");
    if (parent.waiters.length === 0 && parent.spare >= count) parent.spare -= count;
    else parent = await waitForSlots(count, deadline, parent);
  } else {
    parent = undefined;
    if (!tryAcquireSlots(count)) await waitForSlots(count, deadline);
  }
  const allocation: Reservation = {
    capacity: nested,
    spare: nested,
    active: true,
    // A local admission can race its parent's completion before this continuation.
    valid: parent?.valid ?? true,
    parent,
    children: new Set(),
    waiters: [],
  };
  // An expired parent cannot lend these idle spares, even before registration.
  if (!allocation.valid) invalidateReservation(allocation);
  parent?.children.add(allocation);
  try {
    return await reservedFor.run(allocation, () => withTransactionTicket(fn, allocation));
  } finally {
    allocation.active = false;
    invalidateReservation(allocation);
    parent?.children.delete(allocation);
    returnSlots(parent, 1 + allocation.spare);
    // Promoted children may fit globally even when returns stayed in a live parent.
    admitWaiters();
  }
}

// A high-level lock wrapper prepaid the next shared-client transaction. Consume
// that ticket once; a nested transaction must use its own (reserved) slot.
const transactionSlot = new AsyncLocalStorage<{ available: boolean; allocation: Reservation }>();
async function withTransactionTicket<T>(fn: () => Promise<T>, allocation: Reservation): Promise<T> {
  const ticket = { available: true, allocation };
  try {
    return await transactionSlot.run(ticket, fn);
  } finally {
    ticket.available = false;
  }
}
export async function withTransactionSlot<T>(fn: () => Promise<T>): Promise<T> {
  const ticket = transactionSlot.getStore();
  if (ticket?.available && ticket.allocation.valid) {
    ticket.available = false;
    return fn();
  }
  return withLockSlot(() => withTransactionSlot(fn));
}
