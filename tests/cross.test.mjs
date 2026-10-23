// The mark's dot follows the pointer around the mark (src/mark/engine.ts
// overFor): right of the mark it is the logo, left of it the dot sits on the
// other side, and passing over the mark it goes through the dash, as far as
// the pointer has gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CROSS_BAND, overFor } from "../src/mark/engine.ts";

test("past the band on either side the dot rests on that side", () => {
  assert.equal(overFor(CROSS_BAND), 0);
  assert.equal(overFor(5000), 0);
  assert.equal(overFor(-CROSS_BAND), 1);
  assert.equal(overFor(-5000), 1);
});

test("over the mark the dot is half way through the dash", () => {
  assert.equal(overFor(0), 0.5);
});

test("it follows the pointer evenly, never backwards", () => {
  let last = -1;
  for (let x = CROSS_BAND; x >= -CROSS_BAND; x -= 10) {
    const over = overFor(x);
    assert.ok(over >= last, `${x}: ${over} after ${last}`);
    last = over;
  }
});
