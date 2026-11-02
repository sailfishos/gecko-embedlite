/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run with node embedding/embedlite/tests/test-remote-security-startup.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const helperSource = fs.readFileSync(path.join(__dirname,
  "../components/modules/EmbedLiteGlobalHelper.sys.mjs"), "utf8")
  .replace("export function EmbedLiteGlobalHelper", "function EmbedLiteGlobalHelper");
// Exercise the actual Gecko timer startup too: registering a timer alone does
// not start it when the embedding omits XRE's profile startup notifier.
const timerSource = fs.readFileSync(path.join(root,
  "gecko-dev/toolkit/components/timermanager/UpdateTimerManager.sys.mjs"), "utf8")
  .replace(/^import .*;$/m, "")
  .replace("export function TimerManager", "function TimerManager");

function startProfile() {
  const observers = new Map();
  const order = [];
  let securityInits = 0;
  let timerStarts = 0;
  const prefs = new Map();
  const classes = {};
  const services = {
    obs: {
      addObserver(observer, topic) {
        if (!observers.has(topic)) observers.set(topic, new Set());
        observers.get(topic).add(observer);
      },
      removeObserver(observer, topic) { observers.get(topic)?.delete(observer); }
    },
    prefs: {
      getIntPref(key, fallback) { return prefs.get(key) ?? fallback; },
      setIntPref(key, value) { prefs.set(key, value); },
      getBoolPref(key, fallback) { return fallback; },
      getDefaultBranch() { return { setBoolPref() {}, getStringPref() { return "0.1"; } }; }
    },
    scriptloader: { loadSubScript(uri, scope) { scope.Logger = { debug() {} }; } },
    ppmm: { loadProcessScript() {} }
  };
  const chrome = {
    importESModule(uri) {
      if (uri.endsWith("/RemoteSecuritySettings.sys.mjs")) {
        return { RemoteSecuritySettings: { init() { securityInits++; order.push("security"); } } };
      }
      return { LoginManagerParent: {} };
    },
    registerWindowActor() {}, unregisterWindowActor() {}, registerProcessActor() {},
    generateQI() { return () => {}; }, addProfilerMarker() {}
  };
  const interfaces = { nsIObserver: {}, nsITimer: { TYPE_REPEATING_SLACK: 1 } };
  const timerScope = {
    Services: services, ChromeUtils: chrome, Cc: classes, Ci: interfaces,
    Components: { ID: x => x },
    XPCOMUtils: { defineLazyPreferenceGetter(obj, name, pref, value) { obj[name] = value; } }
  };
  vm.runInNewContext(timerSource + "\nglobalThis.manager = new TimerManager();", timerScope);
  classes["@mozilla.org/updates/timer-manager;1"] = {
    getService(iid) { assert.equal(iid, interfaces.nsIObserver); return timerScope.manager; }
  };
  classes["@mozilla.org/timer;1"] = { createInstance() { return {
    initWithCallback(callback, delay) {
      assert.equal(callback, timerScope.manager);
      assert.equal(delay, 30000);
      timerStarts++; order.push("timer");
    }, cancel() {}
  }; } };
  const scope = {
    Services: services, ChromeUtils: chrome,
    Components: { classes, interfaces, results: {}, ID: x => x }
  };
  vm.runInNewContext(helperSource + "\nglobalThis.helper = new EmbedLiteGlobalHelper();", scope);
  scope.helper.observe(null, "app-startup", null);
  timerScope.manager.registerTimer("existing-ua-updates", { notify() {} }, 86400);
  assert.equal(securityInits, 0, "Security startup waits for the profile");
  assert.equal(timerStarts, 0, "Registering UA updates cannot start an uninitialized manager");
  const notify = topic => {
    for (const observer of [...(observers.get(topic) ?? [])]) observer.observe(null, topic, "startup");
  };
  notify("profile-after-change");
  assert.equal(securityInits, 1);
  assert.equal(timerStarts, 1);
  assert.deepEqual(order, ["security", "timer"], "Consumers are ready before polling begins");
  assert.ok(timerScope.manager._timers["existing-ua-updates"], "Existing UA timer is retained");
  notify("profile-after-change");
  assert.equal(securityInits, 1, "Startup observer is removed after initialization");
  notify("profile-before-change");
  assert.equal(timerScope.manager._timer, null, "Shared timer follows profile shutdown");
}

startProfile();
startProfile(); // Each embedding's profile initializes independently.
console.log("Remote security and shared update timer startup tests passed");
