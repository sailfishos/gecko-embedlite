/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
    '../components/modules/PrivateDataManager.sys.mjs'), 'utf8');
const replies = [];
const observers = [];
let complete;
let requestedFlags;
let fail = false;
const context = vm.createContext({
    Components: {
        classes: {}, interfaces: { nsIClearDataService: { CLEAR_COOKIES: 1, CLEAR_DOM_STORAGES: 2 } },
        results: {}, utils: { reportError() {} }, ID: value => value
    },
    ChromeUtils: { importESModule: () => ({}), generateQI: () => () => {} },
    Services: {
        scriptloader: { loadSubScript(url, scope) { scope.Logger = { debug() {} }; } },
        obs: {
            addObserver(observer, topic) { observers.push(topic); },
            notifyObservers(subject, topic, data) { replies.push([topic, JSON.parse(data)]); }
        },
        clearData: { deleteData(flags, callback) {
            if (fail) throw new Error('storage unavailable');
            requestedFlags = flags;
            complete = callback;
        } }
    }
});
vm.runInContext(source.replace('export function PrivateDataManager', 'function PrivateDataManager')
    + '\nthis.manager = new PrivateDataManager();', context);
context.manager.observe(null, 'app-startup', null);
assert(observers.includes('clear-site-data-on-exit'));
context.manager.observe(null, 'clear-site-data-on-exit', '17');
assert.equal(requestedFlags, 3, 'Only cookies and DOM storage are requested');
assert.equal(replies.length, 0, 'Do not acknowledge before asynchronous deletion completes');
complete(0);
assert.deepEqual(replies.pop(), ['site-data-cleared', {requestId: '17', failedFlags: 0}]);
context.manager.observe(null, 'clear-site-data-on-exit', '18');
complete(2);
assert.deepEqual(replies.pop(), ['site-data-cleared', {requestId: '18', failedFlags: 2}]);
fail = true;
context.manager.observe(null, 'clear-site-data-on-exit', '19');
assert.deepEqual(replies.pop(), ['site-data-cleared', {requestId: '19', failedFlags: 3}]);
console.log('Site-data cleanup completion, failure and scope tests passed');
