import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ clean: vi.fn().mockResolvedValue(0) }));
vi.mock("./connection.js", () => ({ redisConnection: {}, createRedisConnection: vi.fn() }));
vi.mock("./retention.js", () => ({ cleanQueuePayloads: state.clean }));
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(
      public name: string,
      public opts: object,
    ) {}
    on() {
      return this;
    }
  },
  FlowProducer: class {},
  Job: class {},
  QueueEvents: class {},
  Worker: class {},
}));
const { notifyDataDeletionsQueue, cleanExpiredQueuePayloads, QUEUE_NAMES } = await import(
  "./index.js"
);
describe("data deletion notice queue", () => {
  it("uses one attempt and participates in idle payload cleanup", async () => {
    expect(notifyDataDeletionsQueue.name).toBe(QUEUE_NAMES.notifyDataDeletions);
    expect(notifyDataDeletionsQueue.opts.defaultJobOptions?.attempts).toBe(1);
    await cleanExpiredQueuePayloads();
    expect(state.clean).toHaveBeenCalledWith(expect.arrayContaining([notifyDataDeletionsQueue]));
    expect(state.clean.mock.calls[0]![0]).toHaveLength(Object.keys(QUEUE_NAMES).length);
  });
});
