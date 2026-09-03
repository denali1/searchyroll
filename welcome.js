"use strict";

const ACK_KEY = "searchyrollDisclaimerAck";

const gate = document.getElementById("syr-ack-gate");
const content = document.getElementById("syr-welcome-content");
const ackButton = document.getElementById("syr-ack-button");

const revealContent = () => {
  gate.hidden = true;
  content.hidden = false;
};

const run = () => {
  if (!gate || !content || !ackButton) {
    return;
  }

  try {
    browser.storage.local.get(ACK_KEY).then((result) => {
      if (result && result[ACK_KEY] === true) {
        revealContent();
      }
    }).catch(() => {});
  } catch (_e) {}

  ackButton.addEventListener("click", () => {
    try {
      browser.storage.local.set({ [ACK_KEY]: true }).then(() => {
        revealContent();
      }).catch(() => {
        revealContent();
      });
    } catch (_e) {
      revealContent();
    }
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}
