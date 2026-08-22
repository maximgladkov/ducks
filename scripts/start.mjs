#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let shuttingDown = false;
const urlFile = path.join(root, "TV_URL.txt");

function log(msg) {
  console.log(`\n[duckhunt] ${msg}`);
}

function run(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: opts.silent ? "ignore" : "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...opts.env },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      console.error(`[duckhunt] ${command} exited (${code ?? signal})`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function npmRun(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(args.join(" "))),
    );
  });
}

async function waitHttp(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function getNgrokTunnels(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const data = await res.json();
        const tunnels = data.tunnels ?? [];
        if (tunnels.length >= 1) return tunnels;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function pickHttpsTunnel(tunnels) {
  const https = tunnels.find((t) =>
    String(t.public_url ?? "").startsWith("https://"),
  );
  return https?.public_url ?? tunnels[0]?.public_url ?? null;
}

function printTvBanner(tvUrl) {
  const line = "═".repeat(52);
  console.log(`
${line}
  OPEN ON TV:

      ${tvUrl}

  Controller: ${tvUrl}/c/
  Also saved: ${urlFile}
  Inspector:  http://127.0.0.1:4040
  Ctrl+C to stop
${line}
`);
}

log("Building shared, host, controller…");
await npmRun(["run", "build", "-w", "shared"]);
await npmRun(["run", "build", "-w", "host"]);
await npmRun(["run", "build", "-w", "controller"], { VITE_BASE: "/c/" });

log("Starting gateway (host + controller + signalling on :8787)…");
run("npm", ["run", "dev", "-w", "signalling"], {
  env: { SERVE_STATIC: "1", PORT: "8787" },
});

if (!(await waitHttp("http://127.0.0.1:8787/health"))) {
  console.error("[duckhunt] Gateway did not become ready in time.");
  shutdown(1);
}

const hasNgrok = await new Promise((resolve) => {
  const check = spawn("ngrok", ["version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  check.on("error", () => resolve(false));
  check.on("exit", (code) => resolve(code === 0));
});

if (!hasNgrok) {
  log("ngrok not found — open http://localhost:8787 on this machine only.");
  await new Promise(() => {});
}

const home = process.env.HOME ?? "";
const authConfigCandidates = [
  path.join(home, "Library/Application Support/ngrok/ngrok.yml"),
  path.join(home, ".config/ngrok/ngrok.yml"),
  path.join(home, ".ngrok2/ngrok.yml"),
  process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "", "ngrok/ngrok.yml")
    : "",
].filter(Boolean);

const authConfigs = [];
for (const candidate of authConfigCandidates) {
  try {
    accessSync(candidate, constants.R_OK);
    authConfigs.push(candidate);
  } catch {
    /* skip */
  }
}

if (authConfigs.length === 0) {
  log("No ngrok authtoken — run: ngrok config add-authtoken YOUR_TOKEN");
  log("Local gateway: http://localhost:8787");
  await new Promise(() => {});
}

log("Starting ngrok in background (no terminal UI)…");
const ngrokLog = path.join(root, ".ngrok.log");
const ngrokArgs = [
  "http",
  "8787",
  "--log",
  ngrokLog,
  "--log-format",
  "logfmt",
];
for (const cfg of authConfigs) {
  ngrokArgs.unshift("--config", cfg);
}
run("ngrok", ngrokArgs, { silent: true });

const tunnels = await getNgrokTunnels();
if (!tunnels) {
  log("ngrok API not ready — check http://127.0.0.1:4040");
  log(`ngrok log: ${ngrokLog}`);
  log("Local gateway: http://localhost:8787");
  await new Promise(() => {});
}

const publicUrl = pickHttpsTunnel(tunnels);
if (!publicUrl) {
  log("No public tunnel URL found.");
  console.log(tunnels);
  await new Promise(() => {});
}

const tvUrl = publicUrl.replace(/\/$/, "");

writeFileSync(
  urlFile,
  `FULL=${tvUrl}\nCONTROLLER=${tvUrl}/c/\n`,
  "utf8",
);

printTvBanner(tvUrl);

try {
  if (process.platform === "darwin") {
    spawn("open", [tvUrl], { stdio: "ignore" });
  }
} catch {
  /* ignore */
}

setInterval(() => {
  printTvBanner(tvUrl);
}, 60_000);

await new Promise(() => {});
