/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const events = new Map(), commands = new Map(), messages = [];
let painted = false;
const measure = value => { assert.ok(painted, 'No layout reads before paint'); return value; };
const root = {};
for (const name of ['scrollWidth', 'scrollHeight'])
  Object.defineProperty(root, name, { get: () => measure(400) });
const viewport = { addEventListener() {}, removeEventListener() {} };
for (const name of ['width', 'height', 'pageLeft', 'pageTop'])
  Object.defineProperty(viewport, name, { get: () => measure(100) });
const content = { document: { scrollingElement: root }, visualViewport: viewport,
  windowGlobalChild: { innerWindowId: 7 },
  screen: { orientation: { type: 'portrait-primary', addEventListener() {} } },
  windowUtils: { getPresShellId: () => measure(1), getViewId: () => measure(2) } };
Object.defineProperty(content.screen, 'mozOrientation', { get() { throw Error('Deprecated orientation read'); } });
for (const [name, value] of Object.entries({ innerWidth: 100, innerHeight: 200, scrollX: 0, scrollY: 0 }))
  Object.defineProperty(content, name, { get: () => measure(value) });
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../content/contentbridge-child.js'), 'utf8'), {
  content, addEventListener: (name, handler) => events.set(name, handler),
  addMessageListener: (name, handler) => commands.set(name, handler),
  sendAsyncMessage: (name, data) => messages.push({ name, data }),
});
const command = name => commands.get('EmbedLiteChrome:Command')({data: {command: name, data: {endpointId: 1}}});
events.get('DOMWindowCreated')({target: content.document});
events.get('DOMContentLoaded')({target: content.document});
events.get('resize')({});
command('set-endpoint'); command('request-state');
assert.equal(messages.filter(m => m.name === 'EmbedLiteChrome:State').at(-1).data.innerWindowId, '7');
painted = true;
events.get('MozAfterPaint')({boundingClientRect: {x: 0, y: 0}, transactionId: 1});
assert.equal(messages.filter(m => m.name === 'EmbedLiteChrome:State').at(-1).data.scrollWidth, 400);
assert.equal(messages.filter(m => m.name === 'embed:contentOrientationChanged').at(-1).data.orientation, 'portrait-primary');
events.get('pagehide')({target: content.document});
painted = false;
command('request-state');
events.get('DOMWindowCreated')({target: content.document});
painted = true;
events.get('pageshow')({target: content.document, persisted: true});
assert.equal(messages.at(-1).data.viewportWidth, 100);
console.log('Pre-paint geometry, standard orientation and BFCache state tests passed');
