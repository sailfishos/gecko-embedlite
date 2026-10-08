/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../content/browser.js"), "utf8");
const start = source.indexOf("  function handleContentCommand(event) {");
assert.ok(start >= 0);
const handler = source.slice(start, source.lastIndexOf("\n})();"));
const scope = {
  console: { error(...args) { assert.fail(args.join(" ")); } },
  contentMessageManager() { assert.fail("User-agent changes must not depend on child IPC"); },
};
vm.createContext(scope);
vm.runInContext(handler, scope);
const context = { customUserAgent: "" };
let value;
const browser = {
  browsingContext: context,
  getAttribute(name) {
    if (name === "data-embedlite-command") return "set-user-agent";
    if (name === "data-embedlite-command-name") return value;
    return "{}";
  },
};
for (value of ["Test override", ""]) {
  scope.handleContentCommand({ target: browser });
  // A load can start immediately after the native command returns.
  assert.equal(context.customUserAgent, value);
}
console.log("Synchronous user-agent set/clear routing tests passed");
