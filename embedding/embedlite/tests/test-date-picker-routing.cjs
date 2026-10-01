/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run with node tests/test-date-picker-routing.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let source = fs.readFileSync(
  path.join(__dirname,
    "../components/modules/EmbedLiteDateTimePickerParent.sys.mjs"),
  "utf8"
);
source = source
  .replace(/^import .*DateTimePickerParent\.sys\.mjs";\n/m, "")
  .replace(
    "export class DateTimePickerParent",
    "globalThis.DateTimePickerParent = class DateTimePickerParent"
  );

let listener;
const requests = [];
const removedListeners = [];
const service = {
  getIDByBrowsingContext(context) {
    return context.winId;
  },
  addMessageListener(name, value) {
    assert.equal(name, "embedui:datepickerresponse");
    listener = value;
  },
  removeMessageListener(name, value) {
    assert.equal(name, "embedui:datepickerresponse");
    removedListeners.push(value);
    if (listener === value) {
      listener = null;
    }
  },
  sendAsyncMessage(winId, name, json) {
    requests.push({ winId, name, data: JSON.parse(json) });
  },
};

class GeckoDateTimePickerParent {
  constructor() {
    this.browsingContext = { canOpenModalPicker: true, winId: 42 };
    this.messages = [];
  }

  receiveMessage(message) {
    this.fallbackMessage = message;
  }

  showPicker(data) {
    this.fallbackPicker = data;
  }

  close() {
    this.fallbackClosed = true;
  }

  sendAsyncMessage(name, data) {
    this.messages.push({ name, data });
  }
}

const scope = {
  GeckoDateTimePickerParent,
  Components: {
    classes: {
      "@mozilla.org/embedlite-app-service;1": {
        getService() {
          return service;
        },
      },
    },
    interfaces: { nsIEmbedAppService: {} },
  },
  ChromeUtils: { generateQI() { return function() {}; } },
  console: { error() {}, warn() {} },
};
vm.createContext(scope);
vm.runInContext(source, scope);

const DAY = 24 * 60 * 60 * 1000;
const dateValue = Date.UTC(2026, 8, 17);
const actor = new scope.DateTimePickerParent();
actor.showPicker({
  type: "date",
  detail: {
    value: { year: 2026, month: 9, day: 17 },
    min: dateValue - DAY,
    max: dateValue + DAY,
    step: DAY,
    stepBase: 0,
  },
});

assert.equal(requests.length, 1);
assert.equal(requests[0].winId, 42);
assert.equal(requests[0].name, "embed:datepicker");
assert.deepEqual(requests[0].data.value, { year: 2026, month: 9, day: 17 });
assert.equal(requests[0].data.min, dateValue - DAY);
const requestId = requests[0].data.id;
assert.ok(listener, "Response listener must be installed before sending");

listener.onMessageReceived(
  "embedui:datepickerresponse",
  JSON.stringify({
    winId: 9,
    id: requestId,
    accepted: true,
    year: 2026,
    month: 9,
    day: 17,
  })
);
assert.equal(actor.messages.length, 0, "Another window's response is ignored");

listener.onMessageReceived(
  "embedui:datepickerresponse",
  JSON.stringify({
    winId: 42,
    id: requestId,
    accepted: true,
    year: 2026,
    month: 9,
    day: 17,
  })
);
assert.deepEqual(JSON.parse(JSON.stringify(actor.messages)), [
  {
    name: "InputPicker:ValueChanged",
    data: { year: 2026, month: 9, day: 17 },
  },
  { name: "InputPicker:Closed", data: {} },
]);
assert.equal(listener, null);
assert.equal(removedListeners.length, 1);

const invalidActor = new scope.DateTimePickerParent();
invalidActor.showPicker({
  type: "date",
  detail: { min: dateValue, max: dateValue, step: DAY, stepBase: 0 },
});
const invalidRequestId = requests[1].data.id;
listener.onMessageReceived(
  "embedui:datepickerresponse",
  JSON.stringify({
    winId: 42,
    id: invalidRequestId,
    accepted: true,
    year: 2026,
    month: 9,
    day: 18,
  })
);
assert.deepEqual(JSON.parse(JSON.stringify(invalidActor.messages)), [
  { name: "InputPicker:Closed", data: {} },
]);

const cancelledActor = new scope.DateTimePickerParent();
cancelledActor.showPicker({ type: "date", detail: {} });
const cancelledRequestId = requests[2].data.id;
cancelledActor.receiveMessage({ name: "InputPicker:Close" });
assert.equal(listener, null);
assert.equal(cancelledActor.messages.length, 0);
assert.deepEqual(requests[3], {
  winId: 42,
  name: "embed:datepickerabort",
  data: { winId: 42, id: cancelledRequestId },
});

const timeActor = new scope.DateTimePickerParent();
const timeRequest = { type: "time", detail: {} };
timeActor.showPicker(timeRequest);
assert.equal(timeActor.fallbackPicker, undefined);
assert.equal(requests.at(-1).data.type, "time");
listener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
  winId: 42, id: requests.at(-1).data.id, accepted: true, hour: 14, minute: 30,
}));
assert.deepEqual(JSON.parse(JSON.stringify(timeActor.messages[0])), {
  name: "InputPicker:ValueChanged",
  data: { hour: 14, minute: 30, second: 0, millisecond: 0 },
});

// Switching backend must tear down the previous picker and route Close to
// the current one, even if a stale native reply arrives afterwards.
for (const type of ["month"]) {
  const switching = new scope.DateTimePickerParent();
  switching.showPicker({ type: "date", detail: {} });
  const staleListener = listener;
  const nativeRequest = requests.at(-1).data;
  switching.showPicker({ type, detail: {} });
  assert.equal(listener, null);
  assert.equal(requests.at(-1).name, "embed:datepickerabort");
  assert.equal(requests.at(-1).data.id, nativeRequest.id);
  assert.equal(switching.fallbackPicker.type, type);
  staleListener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
    ...nativeRequest, accepted: true, year: 2026, month: 9, day: 17,
  }));
  assert.equal(switching.messages.length, 0);
  const close = { name: "InputPicker:Close" };
  switching.receiveMessage(close);
  assert.equal(switching.fallbackMessage, close);

  switching.fallbackClosed = false;
  switching.showPicker({ type: "date", detail: {} });
  assert.equal(switching.fallbackClosed, true, "Native picker closes Gecko panel");
  switching.didDestroy();
  assert.equal(listener, null);
}

for (const [day, accepted] of [[17, true], [18, false], [19, true], [20, false]]) {
  const datetime = new scope.DateTimePickerParent();
  const detail = {
    value: "2026-09-17T12:00",
    min: dateValue + 12 * 3600000,
    max: dateValue + 2 * DAY + 18 * 3600000,
    step: 2 * DAY,
    stepBase: dateValue + 12 * 3600000,
  };
  datetime.showPicker({ type: "datetime-local", detail });
  assert.equal(datetime.fallbackPicker, undefined, "Datetime uses native calendar");
  const request = requests.at(-1).data;
  assert.equal(request.value, "2026-09-17");
  assert.equal(request.dateTime, true);
  assert.equal(request.min, dateValue, "A midday minimum includes its day");
  assert.equal(request.max, dateValue + 2 * DAY, "Maximum includes its day");
  assert.equal(detail.min, dateValue + 12 * 3600000, "Caller detail is unchanged");
  listener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
    winId: 42, id: request.id, accepted: true, year: 2026, month: 9, day,
    hour: 12, minute: 0,
  }));
  assert.equal(datetime.messages.length, accepted ? 2 : 1);
  if (accepted) {
    assert.deepEqual(JSON.parse(JSON.stringify(datetime.messages[0])), {
      name: "InputPicker:ValueChanged",
      data: { year: 2026, month: 9, day, hour: 12, minute: 0, second: 0, millisecond: 0 },
    }, "Date and time are committed together");
  }
  assert.equal(datetime.messages.at(-1).name, "InputPicker:Closed");
  assert.equal(listener, null);
}

for (const step of [60000, 37 * 60000, NaN]) {
  const datetime = new scope.DateTimePickerParent();
  datetime.showPicker({
    type: "datetime-local", detail: { step, stepBase: dateValue + 123456 },
  });
  const request = requests.at(-1).data;
  listener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
    winId: 42, id: request.id, accepted: true, year: 2026, month: 9, day: 17,
    hour: 0, minute: 2, second: 3, millisecond: 456,
  }));
  assert.equal(datetime.messages[0].name, "InputPicker:ValueChanged");
}

for (const type of ["date", "time", "datetime-local"]) {
  const switching = new scope.DateTimePickerParent();
  switching.showPicker({ type, detail: {} });
  const previous = requests.at(-1).data;
  const previousListener = listener;
  switching.showPicker({ type: type === "date" ? "datetime-local" : "date" });
  assert.equal(requests.at(-2).name, "embed:datepickerabort");
  assert.equal(requests.at(-2).data.id, previous.id);
  previousListener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
    ...previous, accepted: true, year: 2026, month: 9, day: 17,
  }));
  assert.equal(switching.messages.length, 0);
  switching.receiveMessage({ name: "InputPicker:Close" });
  assert.equal(listener, null);
  assert.equal(requests.at(-1).name, "embed:datepickerabort");
}
for (const [detail, response, accepted] of [
  [{ min: 9 * 3600000, max: 17 * 3600000 }, { hour: 8, minute: 59 }, false],
  [{ min: 9 * 3600000, max: 17 * 3600000 }, { hour: 17, minute: 0 }, true],
  [{ min: 22 * 3600000, max: 2 * 3600000 }, { hour: 23, minute: 30 }, true],
  [{ min: 22 * 3600000, max: 2 * 3600000 }, { hour: 12, minute: 0 }, false],
  [{ step: 900000 }, { hour: 12, minute: 16 }, false],
  [{ step: 1 }, { hour: 12, minute: 34, second: 56, millisecond: 789 }, true],
  [{}, { hour: 24, minute: 0 }, false],
  [{}, { hour: 12, minute: 60 }, false],
  [{}, { hour: 12, minute: 0, second: 60 }, false],
  [{}, { hour: 12, minute: 0, millisecond: -1 }, false],
]) {
  const time = new scope.DateTimePickerParent();
  time.showPicker({ type: "time", detail });
  listener.onMessageReceived("embedui:datepickerresponse", JSON.stringify({
    winId: 42, id: requests.at(-1).data.id, accepted: true, ...response,
  }));
  assert.equal(time.messages.length, accepted ? 2 : 1);
  if (accepted) {
    assert.deepEqual(JSON.parse(JSON.stringify(time.messages[0].data)), {
      second: 0, millisecond: 0, ...response,
    });
  }
  assert.equal(time.messages.at(-1).name, "InputPicker:Closed");
  assert.equal(listener, null);
}
console.log("Native date/time/datetime constraints, routing and lifecycle tests passed");
