import { describe, expect, test } from "bun:test";
import type { InboxItem } from "@earendil-works/pi-durable";
import { parkRequestId, parkedInputs } from "../src/parking";

const input = (id: number, mode: "steer" | "followUp", content: string): InboxItem =>
  ({ id, mode, content }) as unknown as InboxItem;

const write = (id: number): InboxItem =>
  ({ id, mode: "write", entry: { kind: "app.note", data: "x" } }) as unknown as InboxItem;

describe("what a stop parks", () => {
  test("keeps the user's inputs, in order", () => {
    const parked = parkedInputs([input(3, "followUp", "later"), input(4, "steer", "steer me")]);
    expect(parked).toEqual([
      { mode: "followUp", content: "later", id: "3" },
      { mode: "steer", content: "steer me", id: "4" },
    ]);
  });

  test("leaves queued writes alone — an abort never withdrew them", () => {
    // Re-placing a write would duplicate the entry, so a stop must not touch it.
    expect(parkedInputs([input(1, "followUp", "hi"), write(2)])).toEqual([
      { mode: "followUp", content: "hi", id: "1" },
    ]);
    expect(parkedInputs([write(2)])).toEqual([]);
  });

  test("an empty queue parks nothing", () => {
    expect(parkedInputs([])).toEqual([]);
  });

  test("the request id is stable per conversation and original inbox id", () => {
    expect(parkRequestId(7, "12")).toBe("hearth.park:7:12");
    // Same message, same stop: a rerun replays into the same submission, not a second copy.
    expect(parkRequestId(7, "12")).toBe(parkRequestId(7, "12"));
    // Different conversation or different item: distinct.
    expect(parkRequestId(7, "12")).not.toBe(parkRequestId(8, "12"));
    expect(parkRequestId(7, "12")).not.toBe(parkRequestId(7, "13"));
  });
});

describe("re-parking a queue", () => {
  test("a steer stays a steer and a follow-up stays a follow-up", () => {
    // A steer is placed at the next tool boundary, a follow-up at the next turn boundary: re-parking
    // one as the other would silently change when the user's message lands.
    const parked = parkedInputs([input(1, "steer", "interrupt"), input(2, "followUp", "later")]);
    expect(parked.map((item) => item.mode)).toEqual(["steer", "followUp"]);
  });

  test("a reorder's request ids are its own token, so a rerun does not double a message", () => {
    // A reorder withdraws and re-adds every item; the inbox ids are fresh each time, so the stable
    // key has to come from the reorder itself.
    const first = parkRequestId(3, "99", "order:1:0");
    expect(first).toBe(parkRequestId(3, "99", "order:1:0"));
    expect(first).not.toBe(parkRequestId(3, "99", "order:1:1"));
    expect(first).not.toBe(parkRequestId(3, "99"));
  });
});
