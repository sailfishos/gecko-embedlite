/* SPDX-License-Identifier: MPL-2.0 */
// Run with Node against the managed, patched source tree.
const fs = require("fs");
const assert = require("assert").strict;
const path = require("path").join(__dirname,
  "../gecko-dev/toolkit/mozapps/handling/ContentDispatchChooser.sys.mjs");
const source = fs.readFileSync(path, "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export class", "class")
  .split("nsContentDispatchChooser.prototype")[0];
let listener;
const sent = [], loaded = [], grants = [];
const service = {
  getIDByBrowsingContext: () => 4,
  addMessageListener: (name, value) => { listener = value; },
  removeMessageListener: () => {},
  sendAsyncMessage: (winId, name, data) => { sent.push(JSON.parse(data)); },
};
const Services = {
  perms: {
    ALLOW_ACTION: 1, EXPIRE_NEVER: 0,
    testPermissionFromPrincipal: () => 0,
    addFromPrincipal: (...args) => grants.push(args),
  },
  io: {
    newURI: spec => {
      const uri = new URL(spec);
      return { spec, host: uri.hostname, userPass: uri.username || uri.password,
        schemeIs: scheme => uri.protocol === scheme + ":" };
    },
  },
};
const Clazz = new Function("XPCOMUtils", "AppConstants", "E10SUtils", "Cc", "Ci",
  "ChromeUtils", "Services", "clearTimeout", "setTimeout",
  source + "\nreturn nsContentDispatchChooser;")(
    { defineLazyPreferenceGetter: () => {} },
    { MOZ_WIDGET_TOOLKIT: "qt" },
    { STANDARD_SAFE_PROTOCOLS: ["http", "https"] },
    { "@mozilla.org/embedlite-app-service;1": { getService: () => service } }, {},
    { generateQI: () => function() {} }, Services, clearTimeout, setTimeout);
const chooser = new Clazz();
const principal = { exposablePrePath: "https://login.example",
  schemeIs: scheme => scheme === "https" };
const context = () => ({ isDiscarded: false, currentWindowGlobal: {},
  usePrivateBrowsing: false, loadURI: (...args) => loaded.push(args) });
function response(outcome, fallback = "", remember = false) {
  const request = sent[sent.length - 1];
  listener.onMessageReceived("externalurlresponse", JSON.stringify({
    id: request.id, winId: request.winId, outcome, fallback, remember,
  }));
}
(async () => {
  const url = { scheme: "intent", spec: "intent://callback#Intent;scheme=app;end" };
  let tab = context();
  let pending = chooser.handleURI({}, url, principal, tab);
  response("fallback", "https://example.com/path?q=1#part");
  await pending;
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0][1].triggeringPrincipal, principal);

  // A new fallback document cannot redispatch the same intent in a loop.
  tab.currentWindowGlobal = {};
  let before = sent.length;
  await chooser.handleURI({}, url, principal, tab);
  assert.equal(sent.length, before);

  tab = context();
  pending = chooser.handleURI({}, url, principal, tab);
  tab.currentWindowGlobal = {};
  response("fallback", "https://example.com");
  await pending;
  assert.equal(loaded.length, 1);

  tab = context();
  pending = chooser.handleURI({}, url, principal, tab);
  before = sent.length;
  await chooser.handleURI({}, url, principal, tab);
  assert.equal(sent.length, before);
  response("declined");
  await pending;
  assert.equal(loaded.length, 1);

  tab = context();
  pending = chooser.handleURI({}, url, principal, tab);
  response("dispatched", "", true);
  await pending;
  assert.equal(grants.length, 1);

  tab = context();
  tab.usePrivateBrowsing = true;
  pending = chooser.handleURI({}, url, principal, tab);
  response("dispatched", "", true);
  await pending;
  assert.equal(grants.length, 1);

  tab = context();
  pending = chooser.handleURI({}, url, principal, tab);
  response("fallback", "javascript:alert(1)");
  await pending;
  assert.equal(loaded.length, 1);
  console.log("Gecko chooser: 7 security/context, fallback-loop and duplicate-request checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
