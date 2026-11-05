import { describe, expect, test } from "bun:test";
import { createStreamLimiter, STREAM_LIMITS } from "../src/streamLimit";

/**
 * Admission control exists because the client cannot be trusted: the 0.35.x Ember forgave its
 * reconnect backoff on *open*, so a host that closed a socket immediately got ~27 new connections a
 * second until something else stopped it. These limits bound that at the upgrade, whatever the
 * client does.
 */
describe("stream admission", () => {
  test("a client resubscribing a whole workspace is let through", () => {
    // ~30 conversations plus the task graph, all at once, is a legitimate resume.
    const limiter = createStreamLimiter({ maxConcurrent: 200 });
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.admit("100.64.0.2")).toBe("ok");
    }
  });

  test("a reconnect storm is throttled rather than multiplied", () => {
    let now = 0;
    const limiter = createStreamLimiter({ burst: 4, perSecond: 1, maxConcurrent: 500, now: () => now });
    for (let index = 0; index < 4; index += 1) expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("rate");
    // A second later one token is back.
    now = 1000;
    expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("rate");
  });

  test("one device cannot hold the host's streams forever", () => {
    const limiter = createStreamLimiter({ burst: 100, perSecond: 100, maxConcurrent: 2, now: () => 0 });
    expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("concurrent");
    // Closing one frees the slot, and the close is what tells the limiter.
    limiter.release("mac");
    expect(limiter.admit("mac")).toBe("ok");
  });

  test("peers are independent, and released slots are reusable", () => {
    const limiter = createStreamLimiter({ burst: 10, perSecond: 0, maxConcurrent: 2, now: () => 0 });
    expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("concurrent");
    // Another device is unaffected by the first one's ceiling.
    expect(limiter.admit("phone")).toBe("ok");
    // Closing streams frees the concurrency slots (a token is not refunded: that is the *rate*).
    limiter.release("mac");
    limiter.release("mac");
    expect(limiter.admit("mac")).toBe("ok");
  });

  test("the concurrency ceiling clears Ember's 200 watched conversations", () => {
    // The ceiling must not be tighter than the client's own watch cap, or every stream past it is
    // refused for good and its retries read as a storm (that is how 96 broke this host).
    expect(STREAM_LIMITS.maxConcurrent).toBeGreaterThanOrEqual(200 + 1);
    const limiter = createStreamLimiter({ burst: 500, perSecond: 100, now: () => 0 });
    for (let index = 0; index < 200; index += 1) expect(limiter.admit("mac")).toBe("ok");
    expect(limiter.admit("mac")).toBe("ok"); // the tasks stream
  });

  test("the shipped limits are the ones the refusal copy names", () => {
    expect(STREAM_LIMITS.burst).toBeGreaterThanOrEqual(24);
    const limiter = createStreamLimiter({ now: () => 0 });
    for (let index = 0; index < STREAM_LIMITS.burst; index += 1) {
      expect(limiter.admit("peer")).toBe("ok");
    }
    expect(limiter.admit("peer")).toBe("rate");
  });
});
