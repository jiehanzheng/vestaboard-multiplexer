import assert from "node:assert/strict";
import test from "node:test";
import { routeFromHash, routeToHash } from "../web/src/routes.js";

test("legacy log bookmarks canonicalize without losing their source or adding navigation depth", () => {
  for (const source of [undefined, "codex", "ha-block", "a/b & c"]) {
    const suffix = source ? `?source=${encodeURIComponent(source)}` : "";
    const route = routeFromHash(`#settings/logs${suffix}`);
    assert.deepEqual(route, { view: "logs", logsSource: source });
    assert.equal(routeToHash(route), `#logs${suffix}`);
    assert.deepEqual(routeFromHash(routeToHash(route)), route);
  }
});

test("primary and plugin routes retain their destinations while unknown routes fall back to Board", () => {
  for (const hash of ["#board", "#plugins", "#plugins/codex", "#plugins/barRows", "#plugins/haBlock", "#settings", "#logs"]) {
    assert.equal(routeToHash(routeFromHash(hash)), hash);
  }
  for (const hash of ["", "#missing", "#settings/missing"]) assert.equal(routeToHash(routeFromHash(hash)), "#board");
  assert.equal(routeToHash(routeFromHash("#logs?source=")), "#logs");
});
