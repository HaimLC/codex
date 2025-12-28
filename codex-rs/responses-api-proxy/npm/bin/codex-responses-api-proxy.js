#!/usr/bin/env node
// Entry point for the Codex responses API proxy binary.

import { spawn } from "node:child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function targetCandidates(platform, arch) {
  switch (platform) {
    case "android":
      if (arch === "arm64") {
        return ["aarch64-linux-android", "aarch64-unknown-linux-musl"];
      }
      if (arch === "x64") {
        return ["x86_64-linux-android", "x86_64-unknown-linux-musl"];
      }
      return [];
    case "linux":
      if (arch === "x64") {
        return ["x86_64-unknown-linux-musl"];
      }
      if (arch === "arm64") {
        return ["aarch64-unknown-linux-musl"];
      }
      return [];
    case "darwin":
      if (arch === "x64") {
        return ["x86_64-apple-darwin"];
      }
      if (arch === "arm64") {
        return ["aarch64-apple-darwin"];
      }
      return [];
    case "win32":
      if (arch === "x64") {
        return ["x86_64-pc-windows-msvc"];
      }
      if (arch === "arm64") {
        return ["aarch64-pc-windows-msvc"];
      }
      return [];
    default:
      return [];
  }
}

const candidateTargets = targetCandidates(process.platform, process.arch);
if (candidateTargets.length === 0) {
  throw new Error(
    `Unsupported platform: ${process.platform} (${process.arch})`,
  );
}

const vendorRoot = path.join(__dirname, "..", "vendor");
const binaryBaseName = "codex-responses-api-proxy";
const binaryName =
  process.platform === "win32" ? `${binaryBaseName}.exe` : binaryBaseName;
let binaryPath = null;
for (const targetTriple of candidateTargets) {
  const candidatePath = path.join(
    vendorRoot,
    targetTriple,
    binaryBaseName,
    binaryName,
  );
  if (existsSync(candidatePath)) {
    binaryPath = candidatePath;
    break;
  }
}

if (!binaryPath) {
  throw new Error(
    `Codex responses API proxy binary not found for ${process.platform} (${process.arch}). ` +
      `Searched: ${candidateTargets.join(", ")}`,
  );
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
};

["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => forwardSignal(sig));
});

const childResult = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) {
      resolve({ type: "signal", signal });
    } else {
      resolve({ type: "code", exitCode: code ?? 1 });
    }
  });
});

if (childResult.type === "signal") {
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.exitCode);
}
