/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../content', name), 'utf8');
const events = new Map();
const errors = [];
const scope = {
  ChromeUtils: {
    registerWindowActor() {},
    importESModule() { return {
      attachFrameBridge() {}, listenDocumentMessage() {},
      loadDocumentHelper() { return false; },
      sendDocumentMessage() { throw Error('Text zoom must stay in the parent'); },
    }; },
  },
  document: {
    readyState: 'complete', documentElement: {},
    querySelectorAll() { return []; },
    addEventListener(name, listener) { events.set(name, listener); },
  },
  MutationObserver: class { observe() {} },
  Event: class {},
  console: { error(...args) { errors.push(args); } },
};
vm.runInNewContext(read('browser.js'), scope);
function browser() {
  const attrs = new Map();
  const messages = new Map();
  return {
    localName: 'browser', browsingContext: { textZoom: 1 }, messages,
    getAttribute(name) { return attrs.get(name); },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    dispatchEvent() {},
    messageManager: {
      addMessageListener(name, listener) { messages.set(name, listener); },
      loadFrameScript() {},
      sendAsyncMessage() { throw Error('Text zoom must not reach content'); },
    },
  };
}
function setZoom(tab, zoom) {
  tab.setAttribute('data-embedlite-command', 'send-message');
  tab.setAttribute('data-embedlite-command-name', 'embedui:textZoom');
  tab.setAttribute('data-embedlite-command-data', JSON.stringify({ zoom }));
  events.get('EmbedLiteChromeContentCommand')({ target: tab });
}
const normal = browser(), privateTab = browser(), untouched = browser();
setZoom(normal, 1.6);
setZoom(privateTab, 1.3);
assert.equal(normal.browsingContext.textZoom, 1.6);
assert.equal(privateTab.browsingContext.textZoom, 1.3);
assert.equal(untouched.browsingContext.textZoom, 1);
normal.browsingContext = { textZoom: 1 };
events.get('DidChangeBrowserRemoteness')({ target: normal });
assert.equal(normal.browsingContext.textZoom, 1.6, 'Recreated context gets the setting');
normal.browsingContext = { textZoom: 1.1 };
normal.messages.get('EmbedLiteChrome:State')({ data: {} });
assert.equal(normal.browsingContext.textZoom, 1.6, 'Cached context gets the current setting');
normal.browsingContext = null;
setZoom(normal, 1.8);
normal.browsingContext = { textZoom: 1 };
events.get('XULFrameLoaderCreated')({ target: normal });
assert.equal(normal.browsingContext.textZoom, 1.8, 'Setting can arrive before context creation');
for (const zoom of [0, -1, 'invalid', null, undefined, 1]) {
  setZoom(normal, zoom);
  assert.equal(normal.browsingContext.textZoom, 1);
}
assert.equal(privateTab.browsingContext.textZoom, 1.3);
assert.deepEqual(errors, []);

// Exercise the real frame script's pageshow hook, including a BFCache return.
const childEvents = new Map(), sent = [];
const content = { document: {}, innerWidth: 100, innerHeight: 200, scrollX: 0, scrollY: 0 };
vm.runInNewContext(read('contentbridge-child.js'), {
  content, addEventListener(name, listener) { childEvents.set(name, listener); },
  addMessageListener() {}, sendAsyncMessage(name, data) { sent.push({ name, data }); },
});
sent.length = 0;
childEvents.get('pageshow')({ target: {}, persisted: true });
assert.equal(sent.length, 0, 'Subframe pageshow is ignored');
childEvents.get('pageshow')({ target: content.document, persisted: true });
assert.equal(sent.length, 1);
assert.equal(sent[0].name, 'EmbedLiteChrome:State');
console.log('Text zoom routing, context replacement and BFCache tests passed');
