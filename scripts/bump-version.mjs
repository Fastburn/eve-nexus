#!/usr/bin/env node
// Bumps the version in package.json, src-tauri/Cargo.toml, and
// src-tauri/tauri.conf.json together, since Tauri requires all three to match.
// Also keeps package-lock.json's copy of the version in sync (cosmetic, but
// npm only rewrites it when dependencies change, so it drifts otherwise).
//
// Usage: npm run version:bump -- 0.0.3-beta.1

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
const semverRe = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/;

if (!version || !semverRe.test(version)) {
  console.error("Usage: npm run version:bump -- <version>");
  console.error("Example: npm run version:bump -- 0.0.3-beta.1");
  process.exit(1);
}

// Regex-replaces just the top-level "version" field so the rest of the
// file's formatting (indentation, array line breaks, etc.) is untouched.
function bumpJson(path, label) {
  const full = join(root, path);
  const text = readFileSync(full, "utf8");
  const match = text.match(/^(\s*"version"\s*:\s*")([^"]+)(")/m);
  if (!match) {
    console.error(`Could not find a top-level "version" field in ${path}`);
    process.exit(1);
  }
  const before = match[2];
  const updated = text.replace(/^(\s*"version"\s*:\s*")([^"]+)(")/m, `$1${version}$3`);
  writeFileSync(full, updated);
  console.log(`${label}: ${before} -> ${version}`);
}

// package-lock.json holds the app version twice: the top-level field and the
// root package entry (packages[""]). Replace exactly those two, nothing else.
function bumpPackageLock(path, label) {
  const full = join(root, path);
  const text = readFileSync(full, "utf8");
  const topRe  = /^(  "version"\s*:\s*")([^"]+)(")/m;
  const rootRe = /("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/;
  const match = text.match(topRe);
  if (!match || !rootRe.test(text)) {
    console.error(`Could not find both version fields in ${path}`);
    process.exit(1);
  }
  const before = match[2];
  const updated = text.replace(topRe, `$1${version}$3`).replace(rootRe, `$1${version}$3`);
  writeFileSync(full, updated);
  console.log(`${label}: ${before} -> ${version}`);
}

function bumpCargoToml(path, label) {
  const full = join(root, path);
  const text = readFileSync(full, "utf8");
  const match = text.match(/^version = "([^"]+)"/m);
  if (!match) {
    console.error(`Could not find a version field in ${path}`);
    process.exit(1);
  }
  const before = match[1];
  const updated = text.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  writeFileSync(full, updated);
  console.log(`${label}: ${before} -> ${version}`);
}

bumpJson("package.json", "package.json");
bumpJson("src-tauri/tauri.conf.json", "src-tauri/tauri.conf.json");
bumpPackageLock("package-lock.json", "package-lock.json");
bumpCargoToml("src-tauri/Cargo.toml", "src-tauri/Cargo.toml");

console.log("\nNext steps:");
console.log("  cd src-tauri && cargo check   # updates Cargo.lock to match");
console.log("  git diff                      # review the changes");
console.log("  git add -A && git commit -m \"Bump version to " + version + "\"");
console.log(`  git tag v${version}`);
console.log("  git push && git push --tags");
