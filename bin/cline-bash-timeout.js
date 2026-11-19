#!/usr/bin/env node
// cline-bash-timeout: patch the hard-coded 30 s bash/run_commands timeout in the
// standalone Cline CLI (npm i -g cline). See https://github.com/cline/cline/issues/10549
//
// The CLI ships as a Bun-compiled binary with the JS bundle embedded as text.
// We rewrite the default timeout literal in place. The replacement must have the
// exact same byte length (5 chars), so values are encoded as e.g. "36e5 " (1 h).
// Zero dependencies; works on Linux, WSL, macOS and Windows.

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const SLOT = 5; // length of the original literal "30000"
const MAX_MS = 2147483647; // setTimeout limit (~24.8 days); larger values fire immediately

// Patterns. Group 1 = fixed prefix, group 2 = 5-char numeric slot.
//  - bashTimeoutMs??30000           -> default for the run_commands tool
//  - {shell:...,timeoutMs:X=30000,env:  -> default of the shell executor itself
// The web-fetch tool also has `timeoutMs:X=30000` but is followed by
// `maxResponseBytes`, so it is deliberately not matched.
const NUM = "([0-9e+ ]{5})";
const PATTERNS = [
  new RegExp("(bashTimeoutMs\\?\\?)" + NUM + "(?=,)", "g"),
  new RegExp("(timeoutMs:[A-Za-z_$][A-Za-z0-9_$]{0,2}=)" + NUM + "(?=,env:)", "g"),
];

function usage(code = 0) {
  console.log(`Usage: cline-bash-timeout [options]

Patch the Cline CLI's 30 s command timeout.

Options:
  -t, --timeout <dur>   New timeout, e.g. 600, 600s, 10m, 1h, 2h30m (bare number = seconds).
                        Default: 1h
  -s, --status          Only show the currently patched value(s); change nothing.
  -r, --restore         Restore the original 30 s timeout.
  -b, --binary <path>   Patch this binary instead of auto-detecting.
      --dry-run         Show what would change without writing.
  -h, --help            Show this help.

Re-run after every 'npm i -g cline' update. Close all cline sessions first
(Windows locks running executables; Linux would keep running the old code).`);
  process.exit(code);
}

function parseDuration(s) {
  s = String(s).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0, consumed = "", m;
  while ((m = re.exec(s))) {
    const v = parseFloat(m[1]);
    total += m[2] === "h" ? v * 3600e3 : m[2] === "m" ? v * 60e3 : m[2] === "s" ? v * 1e3 : v;
    consumed += m[0];
  }
  if (!consumed || consumed !== s.replace(/\s+/g, "")) throw new Error(`Cannot parse duration "${s}"`);
  return Math.round(total);
}

// Encode ms as a JS numeric literal of exactly SLOT chars (space padded).
// Returns { lit, ms } where ms is the value actually encoded (may be rounded).
function encode(ms) {
  if (ms < 1000) throw new Error("Timeout must be at least 1 s");
  if (ms > MAX_MS) throw new Error(`Timeout must be at most ${MAX_MS} ms (~24 days)`);
  const pad = (x) => x + " ".repeat(SLOT - x.length);
  if (String(ms).length <= SLOT) return { lit: pad(String(ms)), ms };
  // Try mantissa/exponent forms, most precise first: "MMMeE", "MMeE", "MeE"...
  let best = null;
  for (let e = 1; e <= 9; e++) {
    const mant = Math.round(ms / 10 ** e);
    const lit = `${mant}e${e}`;
    if (mant < 1 || lit.length > SLOT) continue;
    const val = mant * 10 ** e;
    if (val > MAX_MS) continue;
    if (!best || Math.abs(val - ms) < Math.abs(best.ms - ms)) best = { lit: pad(lit), ms: val };
  }
  if (!best) throw new Error(`Cannot encode ${ms} ms in ${SLOT} characters`);
  return best;
}

function fmt(ms) {
  if (ms % 3600e3 === 0) return `${ms / 3600e3}h`;
  if (ms % 60e3 === 0) return `${ms / 60e3}m`;
  return `${ms / 1000}s`;
}

function globalRoot() {
  try {
    return execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Mirror the resolution order of cline's own bin/cline wrapper.
function findBinaries() {
  const root = globalRoot();
  if (!root) throw new Error("Could not run 'npm root -g'. Use --binary <path>.");
  const clineDir = path.join(root, "cline");
  if (!fs.existsSync(clineDir)) throw new Error(`Cline not found in ${root}. Install with: npm i -g cline`);
  const plat = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform] || process.platform;
  const exe = plat === "windows" ? "cline.exe" : "cline";
  const pkg = path.join("@cline", `cli-${plat}-${os.arch()}`, "bin", exe);
  const candidates = [
    process.env.CLINE_BIN_PATH,
    path.join(clineDir, "bin", ".cline"), // postinstall cache (hard link on unix)
    path.join(clineDir, "node_modules", pkg),
    path.join(root, pkg),
  ].filter(Boolean);
  // No inode de-duplication: bin/.cline is often a hard link to the platform
  // binary, and our temp-file+rename write breaks that link, so every path
  // must be patched on its own.
  const out = [...new Set(candidates.map((c) => path.resolve(c)))].filter((c) => fs.existsSync(c));
  if (!out.length) throw new Error("No cline binary found. Use --binary <path>.");
  return out;
}

function scan(text) {
  const hits = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) hits.push({ index: m.index + m[1].length, value: m[2] });
  }
  return hits;
}

function patchFile(file, lit, { dryRun, status }) {
  const buf = fs.readFileSync(file);
  const text = buf.toString("latin1"); // 1 byte <-> 1 char, lossless
  const hits = scan(text);
  if (!hits.length) {
    console.log(`  ${file}\n    no timeout patterns found (unsupported cline version?)`);
    return false;
  }
  const values = [...new Set(hits.map((h) => h.value.trim()))].map((v) => `${v} (${fmt(Number(v))})`);
  console.log(`  ${file}\n    ${hits.length} sites, current: ${values.join(", ")}`);
  if (status) return true;
  if (hits.every((h) => h.value === lit)) {
    console.log("    already set, nothing to do");
    return true;
  }
  if (dryRun) return true;

  for (const h of hits) buf.write(lit, h.index, SLOT, "latin1");

  const backup = file + ".orig";
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  // Write to a temp file then rename: avoids ETXTBSY on Linux when a cline
  // process (e.g. the hub daemon) is running from this file.
  const tmp = file + ".patching";
  const mode = fs.statSync(file).mode;
  fs.writeFileSync(tmp, buf, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e.code === "EBUSY" || e.code === "EPERM")
      throw new Error(`${file} is in use. Close all cline windows/sessions and try again.`);
    throw e;
  }
  console.log(`    patched -> ${lit.trim()} (backup: ${path.basename(backup)})`);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const opts = { timeout: "1h", dryRun: false, status: false, restore: false, binary: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      if (i + 1 >= args.length) usage(1);
      return args[++i];
    };
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "-t" || a === "--timeout") opts.timeout = val();
    else if (a.startsWith("--timeout=")) opts.timeout = a.slice(10);
    else if (a === "-b" || a === "--binary") opts.binary = val();
    else if (a === "-s" || a === "--status") opts.status = true;
    else if (a === "-r" || a === "--restore") opts.restore = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (/^\d/.test(a)) opts.timeout = a; // allow `cline-bash-timeout 10m`
    else {
      console.error(`Unknown option: ${a}`);
      usage(1);
    }
  }

  let lit = null;
  if (!opts.status) {
    const ms = opts.restore ? 30000 : parseDuration(opts.timeout);
    const enc = encode(ms);
    lit = enc.lit;
    const note = enc.ms !== ms ? ` (rounded from ${fmt(ms)} to fit)` : "";
    console.log(`Setting cline command timeout to ${fmt(enc.ms)}${note}${opts.dryRun ? " [dry run]" : ""}`);
  }

  const files = opts.binary ? [opts.binary] : findBinaries();
  let ok = true;
  for (const f of files) {
    try {
      ok = patchFile(f, lit, opts) && ok;
    } catch (e) {
      ok = false;
      const hint = e.code === "EACCES" ? " (permission denied: try sudo / an Administrator shell)" : "";
      console.error(`    error: ${e.message}${hint}`);
    }
  }
  if (!opts.status && !opts.dryRun && ok) {
    console.log("Done. Restart cline (and stop any background cline hub) for the change to take effect.");
    if (process.platform === "darwin")
      console.log("macOS: if cline fails to start, re-sign it: codesign --force --sign - <binary>");
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { encode, parseDuration, scan };
