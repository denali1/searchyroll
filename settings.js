"use strict";

const els = {
  adultToggle: document.getElementById("syr-adult-toggle"),
  adultGate: document.getElementById("syr-adult-gate"),
  adultAck: document.getElementById("syr-adult-ack"),
  adultConfirm: document.getElementById("syr-adult-confirm"),
  adultCancel: document.getElementById("syr-adult-cancel"),
  adultNote: document.getElementById("syr-adult-note"),
  shortcut: document.getElementById("syr-shortcut"),
  shortcutLink: document.getElementById("syr-shortcut-link"),
  clearBtn: document.getElementById("syr-clear-btn"),
  resetBtn: document.getElementById("syr-reset-btn"),
  debugToggle: document.getElementById("syr-debug-toggle"),
  version: document.getElementById("syr-version"),
  lastClear: document.getElementById("syr-last-clear"),
  lastReset: document.getElementById("syr-last-reset"),
  dialogBackdrop: document.getElementById("syr-dialog-backdrop"),
  dialogTitle: document.getElementById("syr-dialog-title"),
  dialogMessage: document.getElementById("syr-dialog-message"),
  dialogCancel: document.getElementById("syr-dialog-cancel"),
  dialogConfirm: document.getElementById("syr-dialog-confirm"),
  toast: document.getElementById("syr-toast")
};

let settings = {
  adultContent: false,
  adultContentAck: false,
  debugMode: false,
  lastClearBrowsingData: null,
  lastCatalogReset: null
};

let toastTimer = null;

const send = (message) =>
  new Promise((resolve) => {
    try {
      browser.runtime.sendMessage(message).then(resolve).catch(() => resolve({ ok: false }));
    } catch (_e) {
      resolve({ ok: false });
    }
  });

const saveSettings = (patch) => {
  const merged = Object.assign({}, settings, patch);
  settings = merged;
  return send({ action: "saveSettings", settings: merged });
};

/* ---- Toast ---- */

const showToast = (message, isError) => {
  if (!els.toast) {
    return;
  }
  els.toast.textContent = message;
  els.toast.classList.toggle("syr-toast-error", isError === true);
  els.toast.hidden = false;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3500);
};

/* ---- Confirmation dialog ---- */

let dialogResolve = null;

const openDialog = (title, message, confirmLabel) =>
  new Promise((resolve) => {
    dialogResolve = resolve;
    els.dialogTitle.textContent = title;
    els.dialogMessage.textContent = message;
    els.dialogConfirm.textContent = confirmLabel || "Continue";
    els.dialogBackdrop.classList.add("syr-open");
  });

const closeDialog = (result) => {
  els.dialogBackdrop.classList.remove("syr-open");
  if (dialogResolve) {
    dialogResolve(result);
    dialogResolve = null;
  }
};

/* ---- Adult content gate ---- */

const resetAdultGate = () => {
  els.adultAck.checked = false;
  els.adultConfirm.disabled = true;
  els.adultGate.hidden = true;
  els.adultNote.hidden = true;
};

const handleAdultToggle = () => {
  if (!els.adultToggle.checked) {
    resetAdultGate();
    saveSettings({ adultContent: false });
    return;
  }
  if (settings.adultContentAck === true) {
    els.adultNote.hidden = true;
    saveSettings({ adultContent: true });
    return;
  }
  // Gate: revert the visual toggle until the 18+ acknowledgement is ticked.
  els.adultToggle.checked = false;
  els.adultAck.checked = false;
  els.adultConfirm.disabled = true;
  els.adultNote.textContent = "Please confirm you are 18 or older to enable mature titles.";
  els.adultNote.hidden = false;
  els.adultGate.hidden = false;
  els.adultAck.focus();
};

const handleAdultAckChange = () => {
  els.adultConfirm.disabled = !els.adultAck.checked;
};

const handleAdultConfirm = () => {
  if (!els.adultAck.checked) {
    return;
  }
  els.adultToggle.checked = true;
  resetAdultGate();
  saveSettings({ adultContent: true, adultContentAck: true }).then(() => {
    showToast("Adult content enabled.");
  });
};

const handleAdultCancel = () => {
  els.adultToggle.checked = false;
  resetAdultGate();
};

/* ---- Debug toggle ---- */

const handleDebugToggle = () => {
  saveSettings({ debugMode: els.debugToggle.checked }).then(() => {
    showToast("Debug logging " + (els.debugToggle.checked ? "enabled." : "disabled."));
  });
};

/* ---- Keyboard shortcut ---- */

const loadShortcut = () => {
  const isFirefox = navigator.userAgent.indexOf("Firefox") !== -1;
  els.shortcutLink.href = isFirefox
    ? "about:addons"
    : "chrome://extensions/shortcuts";
  try {
    browser.commands.getAll().then((commands) => {
      const list = Array.isArray(commands) ? commands : [];
      for (const command of list) {
        if (command && command.name === "toggle-search") {
          els.shortcut.textContent = command.shortcut && command.shortcut !== "" ? command.shortcut : "Not assigned";
          return;
        }
      }
      els.shortcut.textContent = "Not assigned";
    }).catch(() => {
      els.shortcut.textContent = "Unavailable";
    });
  } catch (_e) {
    els.shortcut.textContent = "Unavailable";
  }
};

/* ---- Catalog management ---- */

const formatTimestamp = (iso) => {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleString();
};

const handleClearBrowsingData = () => {
  send({ action: "clearBrowsingData", preview: true }).then((res) => {
    const count = (res && typeof res.count === "number") ? res.count : 0;
    const noun = count === 1 ? "record" : "records";
    openDialog(
      "Clear browsing data?",
      "This will remove " + count + " live-intercepted " + noun + " captured from Crunchyroll and Hidive. Catalog records (from the downloaded catalog) are not affected.",
      "Remove " + count + " " + noun
    ).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      send({ action: "clearBrowsingData" }).then((res) => {
        const cleared = (res && typeof res.count === "number") ? res.count : 0;
        showToast("Cleared " + cleared + " browsing records.");
        refreshTimestamps();
      });
    });
  });
};

const handleResetCatalog = () => {
  send({ action: "resetCatalog", preview: true }).then((res) => {
    const count = (res && typeof res.count === "number") ? res.count : 0;
    const noun = count === 1 ? "title" : "titles";
    openDialog(
      "Reset catalog?",
      "This will delete all " + count + " stored " + noun + " and re-download the catalog. Your browsing history on CR and Hidive will need to be rebuilt. Continue?",
      "Delete and re-download"
    ).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      send({ action: "resetCatalog" }).then((res) => {
        if (res && res.ok) {
          showToast("Catalog reset. Re-downloading…");
          refreshTimestamps();
        } else {
          showToast("Reset catalog failed. Check the console for details.", true);
        }
      });
    });
  });
};

/* ---- Populate ---- */

const refreshTimestamps = () => {
  if (settings.lastClearBrowsingData) {
    els.lastClear.textContent = "Last cleared: " + formatTimestamp(settings.lastClearBrowsingData);
    els.lastClear.hidden = false;
  } else {
    els.lastClear.hidden = true;
  }
  if (settings.lastCatalogReset) {
    els.lastReset.textContent = "Last reset: " + formatTimestamp(settings.lastCatalogReset);
    els.lastReset.hidden = false;
  } else {
    els.lastReset.hidden = true;
  }
};

const populate = () => {
  els.adultToggle.checked = settings.adultContent === true;
  els.debugToggle.checked = settings.debugMode === true;
  refreshTimestamps();
};

const loadSettings = () => {
  send({ action: "getSettings" }).then((res) => {
    if (res && res.ok && res.settings && typeof res.settings === "object") {
      settings = Object.assign({}, settings, res.settings);
    }
    populate();
  });
};

/* ---- Version ---- */

const loadVersion = () => {
  send({ action: "getExtensionVersion" }).then((res) => {
    if (res && res.ok && res.version) {
      els.version.textContent = "Version " + res.version;
    } else {
      els.version.textContent = "Version unavailable";
    }
  });
};

/* ---- Wire events ---- */

const wire = () => {
  els.adultToggle.addEventListener("change", handleAdultToggle);
  els.adultAck.addEventListener("change", handleAdultAckChange);
  els.adultConfirm.addEventListener("click", handleAdultConfirm);
  els.adultCancel.addEventListener("click", handleAdultCancel);
  els.debugToggle.addEventListener("change", handleDebugToggle);
  els.clearBtn.addEventListener("click", handleClearBrowsingData);
  els.resetBtn.addEventListener("click", handleResetCatalog);
  els.dialogCancel.addEventListener("click", () => closeDialog(false));
  els.dialogConfirm.addEventListener("click", () => closeDialog(true));
  els.dialogBackdrop.addEventListener("click", (event) => {
    if (event.target === els.dialogBackdrop) {
      closeDialog(false);
    }
  });
};

const run = () => {
  wire();
  loadShortcut();
  loadSettings();
  loadVersion();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}