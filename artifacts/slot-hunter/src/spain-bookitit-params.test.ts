import test from "node:test";
import assert from "node:assert/strict";
import { buildBookititQueryString, withBookititSelectedPeople } from "./spain-bookitit-params.js";

test("buildBookititQueryString serializes array params as services[] / agendas[]", () => {
  const query = buildBookititQueryString({
    type: "default",
    "services[]": ["bkt853215", "bkt999999"],
    "agendas[]": ["bkt301070"],
    selectedPeople: "1",
  });

  assert.match(query, /services%5B%5D=bkt853215/);
  assert.match(query, /services%5B%5D=bkt999999/);
  assert.match(query, /agendas%5B%5D=bkt301070/);
  assert.doesNotMatch(query, /services=bkt853215/);
});

test("buildBookititQueryString preserves jQuery-style callbacks", () => {
  const query = buildBookititQueryString({
    callback: "jQuery2110626270854092_1785689439147",
    type: "default",
    publickey: "abc123",
  });

  assert.match(query, /callback=jQuery2110626270854092_1785689439147/);
  assert.doesNotMatch(query, /callback=cb/);
});

test("withBookititSelectedPeople adds selectedPeople for datetime-style requests", () => {
  const params = withBookititSelectedPeople({
    callback: "jQuery999_123",
    type: "default",
    publickey: "abc123",
    services: ["bkt853215"],
  });

  const query = buildBookititQueryString(params);

  assert.match(query, /selectedPeople=1/);
  assert.match(query, /services=bkt853215/);
});
