/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { HelperAppLauncherDialog } from "resource://embedlite-components/HelperAppDialog.sys.mjs";

const PDF_VIEWER = "resource://pdf.js/web/viewer.html";

export function getPdfjsActor(context) {
  const window = context?.currentWindowGlobal;
  return window?.documentPrincipal?.spec === PDF_VIEWER
    ? window.getActor("Pdfjs") : null;
}

// Replace desktop chrome operations that depend on Firefox's tabbrowser,
// findbar and saveURL.
export class PdfjsParent extends JSWindowActorParent {
  #findResult = null;
  #query = null;
  #saveTarget = null;
  #picker = null;
  #destroyed = false;

  find(data, emit) {
    this.#query = data.text || null;
    this.#findResult = this.#query ? emit : null;
    this.sendAsyncMessage("PDFJS:Child:handleEvent", {
      type: this.#query ? (data.again ? "findagain" : "find") : "findbarclose",
      detail: {
        query: data.text,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: !!data.backwards,
        matchDiacritics: false,
      },
    });
  }

  save(target) {
    // Only chrome callers can supply a destination. Content supplies a filename
    // to the usual download picker, never a path to write directly.
    if (this.#saveTarget || this.#picker) return;
    this.#saveTarget = target;
    this.sendAsyncMessage("PDFJS:Save");
  }

  receiveMessage(message) {
    if (this.#destroyed) return;

    switch (message.name) {
      case "PDFJS:Parent:updateControlState": {
        const { result, rawQuery } = message.data;
        if (rawQuery === this.#query && Number.isInteger(result) &&
            result >= 0 && result <= 3) this.#findResult?.({ r: result });
        break;
      }
      case "PDFJS:Parent:saveURL": {
        const target = this.#saveTarget;
        this.#saveTarget = null;
        return this.#download(message.data, target).catch(error => {
          console.error("Saving PDF failed", error);
        });
      }
      // Find is connected by find-parent, not a desktop findbar. Optional
      // desktop telemetry, editing and model-service messages need no action.
    }
    return undefined;
  }

  async #download(data, target) {
    if (this.#picker) return;
    const { blobUrl: url, filename } = data;

    let started = false;
    let completed = false;
    try {
      if (!target) {
        const picker = new HelperAppLauncherDialog();
        this.#picker = picker;
        let file;
        try {
          file = await new Promise(resolve => {
            picker.promptForSaveToFileAsync({
              browsingContextId: this.browsingContext.id,
              saveDestinationAvailable: resolve,
            }, null, filename, "", true);
          });
        } finally {
          picker.finishDownloadPicker(null, true);
          this.#picker = null;
        }
        if (!file || this.#destroyed) return;
        target = file.path;
      } else if (target.startsWith("file:")) {
        target = Services.io.newURI(target).QueryInterface(Ci.nsIFileURL).file.path;
      }
      if (this.#destroyed) return;
      const download = await Downloads.createDownload({
        source: {
          url,
          isPrivate: this.browsingContext.usePrivateBrowsing,
          loadingPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        },
        target,
      });
      const list = await Downloads.getList(Downloads.ALL);
      await list.add(download);
      started = true;
      await download.start();
      completed = true;
    } finally {
      // Failed transfers can be retried by the ordinary download manager.
      if (url.startsWith("blob:") && (!started || completed)) URL.revokeObjectURL(url);
    }
  }

  didDestroy() {
    this.#destroyed = true;
    this.#findResult = null;
    this.#saveTarget = null;
    this.#picker?.finishDownloadPicker(null, true);
    this.#picker = null;
  }
}
