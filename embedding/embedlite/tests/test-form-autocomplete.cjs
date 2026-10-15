/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scope = { ChromeUtils: {generateQI() {}}, Ci: {}, Logger: {debug() {}, warn() {}},
  addEventListener() {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome/embedlite/content/FormAssistant.js'), 'utf8'), scope);
scope.LoginUtils._getActionOrigin = () => 'https://example.test';
async function main() {
  let query, resolve;
  const actor = {sendQuery(name, data) { query = {name, data}; return new Promise(r => { resolve = r; }); }};
  const input = {form: {}, value: '', ownerDocument: {defaultView: {windowGlobalChild: {
    getActor(name) { assert.equal(name, 'LoginManager'); return actor; }
  }}}};
  assert.equal(input.ownerGlobal, undefined);
  let result;
  scope.globalObject._getAutoCompleteSuggestions('', input, value => {result = Array.from(value);});
  assert.equal(query.name, 'PasswordManager:findLogins');
  assert.equal(query.data.actionOrigin, 'https://example.test');
  resolve({logins: [{username: 'alice'}, {username: ''}]});
  await Promise.resolve();
  assert.deepEqual(result, ['alice']);
  scope.globalObject._getAutoCompleteSuggestions('', {form: {}, value: '', ownerDocument: {}}, value => {result = Array.from(value);});
  assert.deepEqual(result, []);
  result = null;
  scope.globalObject._getAutoCompleteSuggestions('', input, value => {result = value;});
  input.value = 'typed';
  resolve({logins: [{username: 'alice'}]});
  await Promise.resolve();
  assert.equal(result, null, 'A delayed query must not replace newer input');
  console.log('Autocomplete document actor and delayed reply tests passed');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
