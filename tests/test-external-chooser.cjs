/* SPDX-License-Identifier: MPL-2.0 */
// Run with Node against the managed, patched source tree.
const fs = require("fs");
const assert = require("assert").strict;
const path = require("path").join(__dirname,
  "../gecko-dev/toolkit/mozapps/handling/ContentDispatchChooser.sys.mjs");
const protocolSource = fs.readFileSync(require("path").join(__dirname,
  "../gecko-dev/toolkit/modules/E10SUtils.sys.mjs"), "utf8");
const protocols = JSON.parse(protocolSource.match(
  /const STANDARD_SAFE_PROTOCOLS = (\[[\s\S]*?\]);/)[1].replace(/,\s*]/, "]"));
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
    testPermissionFromPrincipal: (principal, key) =>
      grants.some(grant => grant[0] === principal && grant[1] === key) ? 1 : 0,
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
    { STANDARD_SAFE_PROTOCOLS: protocols },
    { "@mozilla.org/embedlite-app-service;1": { getService: () => service } }, {},
    { generateQI: () => function() {} }, Services, clearTimeout, setTimeout);
const chooser = new Clazz();
const principal = { exposablePrePath: "https://login.example",
  schemeIs: scheme => scheme === "https" };
const context = () => ({ isDiscarded: false, currentWindowGlobal: { documentURI: { spec: "https://login.example/start" } },
  usePrivateBrowsing: false, loadURI: (...args) => loaded.push(args) });
function response(outcome, fallback = "", remember = false) {
  const request = sent[sent.length - 1];
  listener.onMessageReceived("externalurlresponse", JSON.stringify({
    id: request.id, winId: request.winId, outcome, fallback, remember,
  }));
}
(async () => {
  const url = { scheme: "intent", spec: "intent://callback#Intent;scheme=app;end" };
  const custom = { scheme: "oauth", spec: "oauth://callback" };
  let checks = 0;
  async function check(name, test) {
    sent.length = loaded.length = grants.length = 0;
    await test();
    ++checks;
    console.log("PASS: " + name);
  }
  await check("all real standard external protocols use the embedder", async () => {
    assert(protocols.includes("geo") && protocols.includes("mailto") && protocols.includes("tel"));
    for (const scheme of protocols) {
      const before = sent.length;
      const pending = chooser.handleURI({}, {scheme, spec: scheme + ":test"}, principal, context());
      assert.equal(sent.length, before + 1, scheme);
      response("declined");
      await pending;
    }
  });
  await check("fallback retains its triggering principal", async () => {
    const pending = chooser.handleURI({}, url, principal, context());
    response("fallback", "https://example.com/path?q=1#part");
    await pending;
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0][1].triggeringPrincipal, principal);
  });
  await check("automatic fallback redirects cannot loop", async () => {
    const tab = context();
    const pending = chooser.handleURI({}, url, principal, tab);
    response("fallback", "https://example.com/fallback");
    await pending;
    await chooser.handleURI({}, url, principal, tab);
    tab.currentWindowGlobal = { documentURI: { spec: "https://example.com/fallback" } };
    await chooser.handleURI({}, url, principal, tab);
    tab.currentWindowGlobal = {
      documentURI: { spec: "https://example.com/redirected" },
      documentChannel: { originalURI: { spec: "https://example.com/fallback" } },
    };
    await chooser.handleURI({}, url, principal, tab);
    assert.equal(sent.length, 1);
  });
  await check("a user gesture can retry from the fallback document", async () => {
    const tab = context();
    let pending = chooser.handleURI({}, url, principal, tab);
    response("fallback", "https://example.com/fallback");
    await pending;
    tab.currentWindowGlobal = { documentURI: { spec: "https://example.com/fallback" } };
    pending = chooser.handleURI({}, url, principal, tab, false, true);
    assert.equal(sent.length, 2);
    response("dispatched");
    await pending;
  });
  await check("independent navigation allows the same intent again", async () => {
    const tab = context();
    let pending = chooser.handleURI({}, url, principal, tab);
    response("fallback", "https://example.com/fallback");
    await pending;
    tab.currentWindowGlobal = { documentURI: { spec: "https://login.example/retry" } };
    pending = chooser.handleURI({}, url, principal, tab);
    assert.equal(sent.length, 2);
    response("declined");
    await pending;
  });
  await check("navigation invalidates a pending fallback", async () => {
    const tab = context();
    const pending = chooser.handleURI({}, url, principal, tab);
    tab.currentWindowGlobal = {};
    response("fallback", "https://example.com");
    await pending;
    assert.equal(loaded.length, 0);
  });
  await check("duplicate pending requests are suppressed", async () => {
    const tab = context();
    const pending = chooser.handleURI({}, url, principal, tab);
    await chooser.handleURI({}, url, principal, tab);
    assert.equal(sent.length, 1);
    response("declined");
    await pending;
  });
  await check("ordinary custom protocol permissions remain usable", async () => {
    let pending = chooser.handleURI({}, custom, principal, context());
    assert.equal(sent[0].canRemember, true);
    response("dispatched", "", true);
    await pending;
    assert.equal(grants.length, 1);
    pending = chooser.handleURI({}, custom, principal, context());
    assert.equal(sent[1].permissionAllowed, true);
    response("dispatched");
    await pending;
  });
  await check("intent grants are neither accepted nor stored", async () => {
    grants.push([principal, chooser._getSkipProtoDialogPermissionKey("intent"), 1, 0]);
    for (const packageName of ["com.example.maps", "com.example.bank"]) {
      const pending = chooser.handleURI({}, { scheme: "intent",
        spec: "intent://callback#Intent;scheme=app;package=" + packageName + ";end" }, principal, context());
      assert.equal(sent[sent.length - 1].canRemember, false);
      assert.equal(sent[sent.length - 1].permissionAllowed, false);
      response("dispatched", "", true);
      await pending;
      assert.equal(grants.length, 1);
    }
  });
  await check("private contexts cannot store permissions", async () => {
    const tab = context();
    tab.usePrivateBrowsing = true;
    grants.push([principal, chooser._getSkipProtoDialogPermissionKey("oauth"), 1, 0]);
    const pending = chooser.handleURI({}, custom, principal, tab);
    assert.equal(sent[0].canRemember, false);
    assert.equal(sent[0].permissionAllowed, true);
    response("dispatched", "", true);
    await pending;
    assert.equal(grants.length, 1);
  });
  await check("unsafe fallbacks are rejected", async () => {
    for (const fallback of ["javascript:alert(1)", "https://user:pass@example.com"]) {
      const pending = chooser.handleURI({}, url, principal, context());
      response("fallback", fallback);
      await pending;
      assert.equal(loaded.length, 0);
    }
  });
  console.log("Gecko chooser: " + checks + " regression groups passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
