/* SPDX-FileCopyrightText: 2026 Jolla Mobile Ltd
 * SPDX-License-Identifier: MPL-2.0 */

import { DateTimePickerChild as GeckoDateTimePickerChild } from "moz-src:///toolkit/actors/DateTimePickerChild.sys.mjs";

export class DateTimePickerChild extends GeckoDateTimePickerChild {
  openPickerImpl(input) {
    const detail = super.openPickerImpl(input);
    if (
      detail && input.value &&
      (input.type === "time" || input.type === "datetime-local")
    ) {
      // DateTimeValue only contains date/hour/minute fields. Prefer the full
      // value when available, keeping the upstream partial-value fallback.
      detail.value = input.value;
    }
    return detail;
  }

  pickerValueChangedImpl(message, input) {
    if (input.type !== "time" && input.type !== "datetime-local") {
      super.pickerValueChangedImpl(message, input);
      return;
    }

    // The upstream widget accepts partial hour/minute updates and ignores
    // seconds. Native pickers return a complete, parent-validated value.
    const { year, month, day, hour, minute, second, millisecond } = message.data;
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    let value = `${pad(hour)}:${pad(minute)}`;
    if (second || millisecond) {
      value += `:${pad(second)}`;
      if (millisecond) {
        value += `.${pad(millisecond, 3).replace(/0+$/, "")}`;
      }
    }
    let numeric = hour * 3600000 + minute * 60000 + second * 1000 + millisecond;
    if (input.type === "datetime-local") {
      value = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${value}`;
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      numeric += date.getTime();
    }
    // Avoid firing input/change again for an unchanged value, even when its
    // string uses another equivalent precision (e.g. 12:00:00 versus 12:00).
    if (input.valueAsNumber !== numeric) {
      input.setUserInput(value);
    }
    // setUserInput assumes the widget initiated the change and does not notify
    // it. Refresh from the current DOM value, including any script-side edits.
    input.dateTimeBoxElement?.dispatchEvent(
      new input.documentGlobal.Event("MozDateTimeValueChanged")
    );
  }
}
