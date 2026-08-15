#!/usr/bin/env bun
// glikvm-mod - patch the GLKVM Windows desktop client (Electron) so sessions can
// live in separate windows and the local clipboard can be pasted straight into
// the remote machine.
//
//   bun patch.ts build                 extract + patch into ./build/app (no install)
//   bun patch.ts install               build + install a side-by-side copy (no admin)
//   bun patch.ts install --inplace     build + drop resources/app into the stock install (needs elevated shell)
//   bun patch.ts uninstall [--inplace] remove the mod
//   bun patch.ts run [-- args]         launch the modded client
//   bun patch.ts status
//
// Options: --src <dir>  stock install (default: C:\Program Files\GLKVM)
//          --dest <dir> side-by-side install dir (default: %LOCALAPPDATA%\Programs\GLKVM-mod)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { extractAll } from "@electron/asar";
import { allPatches, MOD_VERSION } from "./src/patches";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "help";
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SRC = opt("src", "C:\\Program Files\\GLKVM");
const DEST = opt("dest", path.join(process.env.LOCALAPPDATA ?? "", "Programs", "GLKVM-mod"));
const INPLACE = flag("inplace");
const BUILD = path.join(HERE, "build");
const BUILD_APP = path.join(BUILD, "app");
const SHORTCUT = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "GLKVM (mod).lnk");
const MARKER = "glikvm-mod.json";

const log = (...a: unknown[]) => console.log("•", ...a);
const die = (msg: string): never => {
  console.error("✗", msg);
  process.exit(1);
};

function sha256(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function stockAsar() {
  const p = path.join(SRC, "resources", "app.asar");
  if (!fs.existsSync(p)) die(`stock app.asar not found at ${p} (use --src <dir>)`);
  return p;
}

function syntaxCheck(file: string) {
  const code = fs.readFileSync(file, "utf8");
  new Bun.Transpiler({ loader: "js" }).transformSync(code); // throws on parse error
}

function build() {
  const asar = stockAsar();
  try {
    fs.rmSync(BUILD_APP, { recursive: true, force: true });
  } catch (e: any) {
    if (e.code !== "EBUSY" && e.code !== "EPERM") throw e;
    // something (a shell?) has build/app as its cwd - move it aside and carry on
    const aside = `${BUILD_APP}.old-${Date.now()}`;
    fs.renameSync(BUILD_APP, aside);
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      log(`(could not delete ${aside}; remove it by hand later)`);
    }
  }
  fs.mkdirSync(BUILD_APP, { recursive: true });
  log(`extracting ${asar}`);
  extractAll(asar, BUILD_APP);
  const pkg = JSON.parse(fs.readFileSync(path.join(BUILD_APP, "package.json"), "utf8"));
  log(`stock client version ${pkg.version}`);
  const patches = allPatches(BUILD_APP);
  const touched = new Set<string>();
  for (const p of patches) {
    const file = path.join(BUILD_APP, p.file);
    const before = fs.readFileSync(file, "utf8");
    const after = p.apply(before);
    if (after === before) die(`patch produced no change: ${p.what}`);
    fs.writeFileSync(file, after);
    touched.add(file);
    log(`patched: ${p.what}`);
  }
  for (const f of touched) syntaxCheck(f);
  log(`syntax OK for ${touched.size} patched files`);
  fs.writeFileSync(
    path.join(BUILD_APP, MARKER),
    JSON.stringify({ modVersion: MOD_VERSION, appVersion: pkg.version, sourceAsarSha256: sha256(asar), builtAt: new Date().toISOString() }, null, 2),
  );
  return pkg.version as string;
}

function robocopy(src: string, dst: string, extra: string[]) {
  const r = Bun.spawnSync(["robocopy", src, dst, ...extra, "/R:2", "/W:1", "/NJH", "/NJS", "/NDL", "/NFL", "/NP"], { stdout: "pipe", stderr: "pipe" });
  const code = r.exitCode ?? 99;
  if (code >= 8) {
    console.error(r.stdout.toString(), r.stderr.toString());
    die(`robocopy ${src} -> ${dst} failed (exit ${code}). Is the modded client still running?`);
  }
}

function makeShortcut(exe: string) {
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${SHORTCUT.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${exe.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${path.dirname(exe).replace(/'/g, "''")}'`,
    `$s.IconLocation = '${exe.replace(/'/g, "''")},0'`,
    `$s.Description = 'GLKVM with glikvm-mod (multi-window sessions, clipboard paste)'`,
    `$s.Save()`,
  ].join("; ");
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) log(`(could not create Start Menu shortcut: ${r.stderr.toString().trim()})`);
  else log(`Start Menu shortcut: ${SHORTCUT}`);
}

function install() {
  const version = build();
  if (INPLACE) {
    const target = path.join(SRC, "resources", "app");
    log(`installing in place -> ${target}`);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(BUILD_APP, target, { recursive: true });
    } catch (e: any) {
      die(`cannot write to ${target} (${e.code}). Run this from an elevated (Administrator) shell, or use the default side-by-side install.`);
    }
    log(`done. Electron loads resources/app in preference to app.asar, so the stock GLKVM.exe now runs the mod.`);
    log(`NOTE: after a GLKVM update, re-run 'bun patch.ts install --inplace' (or uninstall) - a stale resources/app would shadow the new app.asar.`);
    return;
  }
  log(`installing side-by-side -> ${DEST}`);
  fs.mkdirSync(DEST, { recursive: true });
  // 1) stock binaries (Electron runtime, helpers, locales) - everything except the stock app payload
  robocopy(SRC, DEST, ["/E", "/XF", "app.asar", "Uninstall GLKVM.exe", "/XD", "app.asar.unpacked", "app"]);
  // 2) patched app
  robocopy(BUILD_APP, path.join(DEST, "resources", "app"), ["/MIR"]);
  const exe = path.join(DEST, "GLKVM.exe");
  makeShortcut(exe);
  log(`installed glikvm-mod ${MOD_VERSION} on GLKVM ${version}`);
  log(`run it:  bun patch.ts run   (or the "GLKVM (mod)" Start Menu entry, or ${exe})`);
  log(`it shares login/settings with the stock client (same %APPDATA%\\gl-kvm). If the stock client is running you will be asked to close it.`);
}

function uninstall() {
  if (INPLACE) {
    const target = path.join(SRC, "resources", "app");
    if (!fs.existsSync(target)) return log(`nothing to remove at ${target}`);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (e: any) {
      die(`cannot remove ${target} (${e.code}); run from an elevated shell`);
    }
    return log(`removed ${target}; stock GLKVM.exe is back to app.asar`);
  }
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
    log(`removed ${DEST}`);
  } else log(`nothing at ${DEST}`);
  if (fs.existsSync(SHORTCUT)) {
    fs.rmSync(SHORTCUT);
    log(`removed ${SHORTCUT}`);
  }
}

function run() {
  const exe = INPLACE ? path.join(SRC, "GLKVM.exe") : path.join(DEST, "GLKVM.exe");
  if (!fs.existsSync(exe)) die(`${exe} not found - run 'bun patch.ts install' first`);
  const child = Bun.spawn([exe, ...passthrough], { cwd: path.dirname(exe), stdio: ["ignore", "ignore", "ignore"], detached: true } as any);
  child.unref();
  log(`launched ${exe} ${passthrough.join(" ")}`.trim());
}

function status() {
  const asar = path.join(SRC, "resources", "app.asar");
  log(`stock install: ${SRC} ${fs.existsSync(asar) ? "(found)" : "(app.asar MISSING)"}`);
  for (const [label, dir] of [
    ["side-by-side", path.join(DEST, "resources", "app")],
    ["in-place", path.join(SRC, "resources", "app")],
  ]) {
    const marker = path.join(dir, MARKER);
    if (!fs.existsSync(marker)) {
      log(`${label}: not installed`);
      continue;
    }
    const m = JSON.parse(fs.readFileSync(marker, "utf8"));
    const stale = fs.existsSync(asar) && sha256(asar) !== m.sourceAsarSha256;
    log(`${label}: mod ${m.modVersion} built from GLKVM ${m.appVersion} at ${m.builtAt}${stale ? "  ⚠ stock app.asar changed since - re-run install" : ""}`);
  }
}

switch (cmd) {
  case "build":
    build();
    log(`build ready at ${BUILD_APP}`);
    break;
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "run":
    run();
    break;
  case "status":
    status();
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
