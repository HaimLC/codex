import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { SandboxMode, ModelReasoningEffort, ApprovalMode } from "./threadOptions";

export type CodexExecArgs = {
  input: string;

  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  // --model
  model?: string;
  // --sandbox
  sandboxMode?: SandboxMode;
  // --cd
  workingDirectory?: string;
  // --add-dir
  additionalDirectories?: string[];
  // --skip-git-repo-check
  skipGitRepoCheck?: boolean;
  // --output-schema
  outputSchemaFile?: string;
  // --config model_reasoning_effort
  modelReasoningEffort?: ModelReasoningEffort;
  // AbortSignal to cancel the execution
  signal?: AbortSignal;
  // --config sandbox_workspace_write.network_access
  networkAccessEnabled?: boolean;
  // --config features.web_search_request
  webSearchEnabled?: boolean;
  // --config approval_policy
  approvalPolicy?: ApprovalMode;
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";

export class CodexExec {
  private executablePath: string;
  private envOverride?: Record<string, string>;

  constructor(executablePath: string | null = null, env?: Record<string, string>) {
    this.executablePath = executablePath || findCodexPath();
    this.envOverride = env;
  }

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    const commandArgs: string[] = ["exec", "--experimental-json"];

    if (args.model) {
      commandArgs.push("--model", args.model);
    }

    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }

    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }

    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push("--add-dir", dir);
      }
    }

    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }

    if (args.outputSchemaFile) {
      commandArgs.push("--output-schema", args.outputSchemaFile);
    }

    if (args.modelReasoningEffort) {
      commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    }

    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`,
      );
    }

    if (args.webSearchEnabled !== undefined) {
      commandArgs.push("--config", `features.web_search_request=${args.webSearchEnabled}`);
    }

    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }

    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }

    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }

    const env: Record<string, string> = {};
    if (this.envOverride) {
      Object.assign(env, this.envOverride);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
    }
    if (args.baseUrl) {
      env.OPENAI_BASE_URL = args.baseUrl;
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey;
    }

    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
    });

    let spawnError: unknown | null = null;
    child.once("error", (err) => (spawnError = err));

    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();

    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }
    const stderrChunks: Buffer[] = [];

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(data);
      });
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        // `line` is a string (Node sets default encoding to utf8 for readline)
        yield line as string;
      }

      const exitCode = new Promise((resolve, reject) => {
        child.once("exit", (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            const stderrBuffer = Buffer.concat(stderrChunks);
            reject(
              new Error(`Codex Exec exited with code ${code}: ${stderrBuffer.toString("utf8")}`),
            );
          }
        });
      });

      if (spawnError) throw spawnError;
      await exitCode;
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
    }
  }
}

const scriptFileName = fileURLToPath(import.meta.url);
const scriptDirName = path.dirname(scriptFileName);

function findCodexPath() {
  const { platform, arch } = process;

  const candidateTargets = (() => {
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
  })();

  if (candidateTargets.length === 0) {
    throw new Error(`Unsupported platform: ${platform} (${arch})`);
  }

  const vendorRoot = path.join(scriptDirName, "..", "vendor");
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const targetTriple of candidateTargets) {
    const binaryPath = path.join(
      vendorRoot,
      targetTriple,
      "codex",
      codexBinaryName,
    );
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  throw new Error(
    `Codex binary not found for ${platform} (${arch}). ` +
      `Searched: ${candidateTargets.join(", ")}`,
  );
}
