// Run: node --test src/lib/format.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLine, clock, parseLrc, toCsv } from "./format.ts";

test("parseLrc handles multi-stamp lines and sorts", () => {
  const lines = parseLrc("[00:12.50]second\n[00:01.00][00:20.00]chorus\nno stamp");
  assert.deepEqual(lines.map((l) => [l.t, l.text]), [[1, "chorus"], [12.5, "second"], [20, "chorus"]]);
});

test("activeLine finds the line playing at a position", () => {
  const lines = parseLrc("[00:01.00]a\n[00:05.00]b\n[00:09.00]c");
  assert.equal(activeLine(lines, 0.5), -1);
  assert.equal(activeLine(lines, 5), 1);
  assert.equal(activeLine(lines, 99), 2);
});

test("clock and csv escaping", () => {
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3725), "1:02:05");
  const csv = toCsv([{ id: "1", key: "k", title: 'Say "Hi", ok', artist: "A", offsetSec: 0, sampleStartMs: 0, identifiedAt: 0, source: "system" }]);
  assert.match(csv.split("\n")[1], /"Say ""Hi"", ok"/);
});
