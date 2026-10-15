/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = process.env.CLICK_BLOCKER_SOURCE || path.join(__dirname,
    '../chrome/embedlite/content/ClickEventBlocker.js');
const sourceRoot = process.env.GECKO_SOURCE_DIR || path.join(__dirname, '../../../gecko-dev');
const securityIdl = fs.readFileSync(path.join(sourceRoot, 'caps/nsIScriptSecurityManager.idl'), 'utf8');
const originCheck = securityIdl.match(/void checkSameOriginURI\(([^)]*)\)/)[1];
assert.equal(originCheck.split(',').length, 4, 'The mock must follow the checked-out origin API');
const replies = [];
const uris = new WeakSet();
const context = vm.createContext({
    // BrowserUtils.makeURI no longer exists in ESR153.
    ChromeUtils: { importESModule: () => ({ BrowserUtils: {} }) },
    Services: {
        io: { newURI(spec) {
            const value = { spec, origin: new URL(spec).origin };
            uris.add(value);
            return value;
        } },
        scriptSecurityManager: { checkSameOriginURI(...args) {
            assert.equal(args.length, 4, 'ESR153 requires fromPrivateWindow');
            assert(uris.has(args[0]) && uris.has(args[1]));
            if (args[0].origin !== args[1].origin) throw new Error('different origin');
        } }
    },
    sendAsyncMessage: (name, data) => replies.push([name, data.uri])
});
vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
const blocker = context.ClickEventBlocker;
let installed, removed;
const frame = {
    addEventListener(name, listener, capture) { installed = [name, listener, capture]; },
    removeEventListener(name, listener, capture) { removed = [name, listener, capture]; }
};
blocker.init(frame, { allowNavigationInSameOrigin: true });
assert.equal(installed[0], 'click');
const root = context.Services.io.newURI('https://login.example/start');
function click(href, form = false) {
    let prevented = false;
    blocker._hrefForClickEvent = () => [root, href, form];
    blocker.handleEvent({ type: 'click', originalTarget: { ownerDocument: {} },
        preventDefault() { prevented = true; } });
    return prevented;
}
assert.equal(click('https://login.example/next'), false, 'same-origin link stays inside the portal');
assert.equal(click('https://elsewhere.example/'), true, 'outside link is handed to the host');
assert.equal(click('https://elsewhere.example/submit', true), false, 'cross-origin form remains allowed');
assert.equal(click('app:/callback'), true, 'native callback is handed to the host');
assert.equal(replies.length, 2);
blocker.init(frame, { allowNavigationInSameOrigin: true });
assert.equal(removed[1], blocker, 'reinitialization removes the previous listener');
console.log('ClickEventBlocker: ESR153 URI/origin API, form, external-link and listener tests passed');
