#!/usr/bin/env node
"use strict";

/*
 * scripts/pack.js
 *
 * Phase 8 (Part 2) — per-target store packs (Firefox/AMO, Chrome&Edge).
 *
 * Standalone Node.js script (built-ins only: fs, path, os, zlib). Reads the
 * dual-key manifest.json at the repo root as the source of truth and emits
 * one zip per target with a store-correct manifest:
 *
 *   Firefox: keep background.scripts, drop background.service_worker,
 *            keep browser_specific_settings (AMO requires gecko.id)
 *   Chrome:  keep background.service_worker, drop background.scripts,
 *            drop browser_specific_settings entirely
 *
 * Zip files are written by hand (local headers + deflated data + central
 * directory + end-of-central-directory) using zlib.deflateRawSync and
 * zlib.crc32 — no npm packages, no OS zip utility, deterministic ordering.
 * The source manifest.json is never modified; all work happens in a temp
 * staging directory that is removed on success AND failure (try/finally).
 *
 * Output:
 *   dist/searchyroll-{version}-{firefox|chrome}.zip
 *
 * Flags:
 *   --target firefox|chrome   build one target only (default: both)
 *
 * Exit 0 on success, 1 on any failure.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// Every runtime file the extension needs. Kept as an explicit whitelist so
// scripts/, catalog/, .github/, proxy/, markdown, LICENSE, package.json and
// the local-only docs can never leak into a store submission.
const WHITELIST = [
  "manifest.json",
  "background.js",
  "search-overlay.js",
  "content-cr.js",
  "content-cr-main.js",
  "content-hidive.js",
  "content-hidive-main.js",
  "popup.html",
  "popup.js",
  "settings.html",
  "settings.css",
  "settings.js",
  "welcome.html",
  "welcome.css",
  "welcome.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

const TARGETS = {
  firefox: {
    transform(manifest) {
      if (manifest.background) {
        delete manifest.background.service_worker;
      }
    }
  },
  chrome: {
    transform(manifest) {
      if (manifest.background) {
        delete manifest.background.scripts;
      }
      delete manifest.browser_specific_settings;
    }
  }
};

const log = (msg) => console.log("[pack] " + msg);

const fail = (msg) => {
  console.error("[pack] " + msg);
  process.exit(1);
};

const bytes = (size) => {
  if (size < 1024) return size + " bytes";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(2) + " MB";
};

/* ------------------------------ ZIP writer ------------------------------ */

const ZIP_LFH_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021; // 1980-01-01 — fixed so builds are byte-deterministic

const crc32 = (buf) => zlib.crc32(buf) >>> 0;

const buildZip = (entries) => {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(ZIP_LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed to extract
    lfh.writeUInt16LE(0, 6); // general purpose flags
    lfh.writeUInt16LE(METHOD_DEFLATE, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc32(entry.data), 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(entry.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra field length
    chunks.push(lfh, nameBuf, compressed);
    central.push({ nameBuf, crc32: crc32(entry.data), offset, compressedLength: compressed.length, data: entry.data });
    offset += lfh.length + nameBuf.length + compressed.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(ZIP_CD_SIG, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed to extract
    cd.writeUInt16LE(0, 8); // general purpose flags
    cd.writeUInt16LE(METHOD_DEFLATE, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(c.crc32, 16);
    cd.writeUInt32LE(c.compressedLength, 20);
    cd.writeUInt32LE(c.data.length, 24);
    cd.writeUInt16LE(c.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra field length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(c.offset, 42); // local header offset
    cdSize += cd.length + c.nameBuf.length;
    chunks.push(cd, c.nameBuf);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(central.length, 8); // entries this disk
  eocd.writeUInt16LE(central.length, 10); // entries total
  eocd.writeUInt32LE(cdSize, 12); // cd size
  eocd.writeUInt32LE(cdStart, 16); // cd start offset
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);
  return Buffer.concat(chunks);
};

/* ------------------------------ packaging ------------------------------- */

const writeJSON = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
};

const packTarget = (manifestSrc, version, target) => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "searchyroll-pack-"));
  try {
    const manifest = JSON.parse(JSON.stringify(manifestSrc));
    TARGETS[target].transform(manifest);
    writeJSON(path.join(staging, "manifest.json"), manifest);

    for (const rel of WHITELIST) {
      if (rel === "manifest.json") {
        continue;
      }
      const srcPath = path.join(ROOT, rel);
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        throw new Error("missing runtime file: " + rel);
      }
      const destPath = path.join(staging, rel);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }

    const entries = [];
    for (const rel of WHITELIST) {
      entries.push({ name: rel, data: fs.readFileSync(path.join(staging, rel)) });
    }

    const zipName = "searchyroll-" + version + "-" + target + ".zip";
    const outPath = path.join(DIST, zipName);
    fs.writeFileSync(outPath, buildZip(entries));
    log(target.toUpperCase() + " -> " + outPath + " (" + entries.length + " files, " + bytes(fs.statSync(outPath).size) + ")");
    for (const rel of WHITELIST) {
      log("  include " + rel);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

const main = () => {
  const args = process.argv.slice(2);
  const wanted = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") {
      const val = args[i + 1];
      if (!val || !TARGETS[String(val).toLowerCase()]) {
        fail("unknown target: " + val + " (expected firefox or chrome)");
      }
      wanted.push(String(val).toLowerCase());
      i += 1;
    } else {
      fail("unknown flag: " + args[i]);
    }
  }
  const targets = wanted.length > 0 ? wanted : ["firefox", "chrome"];

  let manifestSrc;
  try {
    manifestSrc = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  } catch (err) {
    throw new Error("cannot read repo manifest.json: " + err.message);
  }
  const version = manifestSrc && typeof manifestSrc.version === "string" ? manifestSrc.version : null;
  if (!version) {
    throw new Error("manifest.json has no version string");
  }

  fs.mkdirSync(DIST, { recursive: true });
  for (const target of targets) {
    packTarget(manifestSrc, version, target);
  }
  log("done — " + targets.length + " build(s) written to " + DIST);
};

try {
  main();
  process.exit(0);
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}