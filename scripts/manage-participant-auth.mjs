#!/usr/bin/env node
import { randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const KEYS = ["PARTICIPANT_PIN", "PARTICIPANT_SESSION_SECRET"];

/** @typedef {{ envPath?: string, rotate?: boolean, pin?: string, pinFactory?: () => string, secretFactory?: () => string }} WritePairOptions */
/** @typedef {{ status: number | null, error?: Error, stdout?: string | null, stderr?: string | null }} CliResult */
/** @typedef {(command: string, args: string[], options?: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => CliResult} CliSpawn */
/** @typedef {{ target?: string, envPath?: string, projectPath?: string, spawn?: CliSpawn, log?: (message: string) => void }} SyncPairOptions */

export function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(match[1], value);
  }
  return values;
}

export function upsertEnv(content, updates) {
  const lines = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match?.[1] === key) {
        if (!replaced) lines[i] = `${key}=${value}`;
        else lines[i] = `# duplicate ${key} removed by participant-auth generator`;
        replaced = true;
      }
    }
    if (!replaced) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function validatePair(values) {
  const pin = values.get("PARTICIPANT_PIN");
  const secret = values.get("PARTICIPANT_SESSION_SECRET");
  if (!/^\d{4}$/.test(pin ?? ""))
    throw new Error(".env.local must contain a four-digit PARTICIPANT_PIN.");
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(".env.local must contain a PARTICIPANT_SESSION_SECRET of at least 32 bytes.");
  }
  return { pin, secret };
}

/** @param {string} prompt @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [io] */
export function promptHiddenLine(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Generating participant auth values requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    let invalid = false;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("PIN entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          if (invalid || !/^\d{4}$/.test(value)) {
            reject(new Error("PIN must contain exactly four ASCII digits."));
          } else {
            resolve(value);
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (character < " ") continue;
        if (character > "~") {
          invalid = true;
          continue;
        }
        if (character >= "0" && character <= "9" && value.length < 4 && !invalid) {
          value += character;
        } else {
          invalid = true;
        }
      }
    };
    output.write(prompt);
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.resume();
    } catch {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      reject(new Error("Could not start hidden PIN input."));
    }
  });
}

/** @param {WritePairOptions} [options] */
export async function writePair({
  envPath = ENV_PATH,
  rotate = false,
  pin: requestedPin,
  pinFactory,
  secretFactory,
} = {}) {
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read .env.local.");
  }
  const current = parseEnv(content);
  if (!rotate && KEYS.some((key) => current.has(key))) {
    throw new Error(
      "Participant auth values already exist. Use --rotate to replace them deliberately.",
    );
  }
  const pin =
    requestedPin ?? (pinFactory ?? (() => randomInt(0, 10_000).toString().padStart(4, "0")))();
  if (!/^\d{4}$/.test(pin)) throw new Error("PIN must contain exactly four ASCII digits.");
  const secret = (secretFactory ?? (() => randomBytes(32).toString("base64url")))();
  const updated = upsertEnv(content, { PARTICIPANT_PIN: pin, PARTICIPANT_SESSION_SECRET: secret });
  const temporaryPath = `${envPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error("Could not securely save .env.local.");
  }
  return { pin };
}

/** @param {string[]} args @param {string | undefined} input @param {CliSpawn} spawn */
function runCli(args, input, spawn = spawnSync) {
  return spawn("vercel", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function resultFailed(result) {
  return result.error || result.status !== 0;
}

/** @param {SyncPairOptions} [options] */
export async function syncPair({
  target,
  envPath = ENV_PATH,
  projectPath = resolve(ROOT, ".vercel/project.json"),
  spawn = spawnSync,
  log = console.log,
} = {}) {
  if (!new Set(["production", "preview"]).has(target)) {
    throw new Error(
      "Choose --target production or --target preview. Sensitive variables are not supported for Development.",
    );
  }
  let project;
  let values;
  try {
    project = JSON.parse(await readFile(projectPath, "utf8"));
    values = parseEnv(await readFile(envPath, "utf8"));
  } catch {
    throw new Error("A linked .vercel/project.json and .env.local are required before syncing.");
  }
  const pair = validatePair(values);
  const projectName = project.projectName || project.projectId;
  if (!projectName) throw new Error("The linked Vercel project has no project name or ID.");

  const identity = runCli(["whoami"], undefined, spawn);
  if (resultFailed(identity))
    throw new Error("Vercel CLI authentication preflight failed; run `vercel login` and retry.");
  log(`Vercel project: ${projectName}; target: ${target}.`);

  const listed = runCli(["env", "ls", target], undefined, spawn);
  if (resultFailed(listed)) {
    throw new Error(`Vercel ${target} environment preflight failed; no variables were changed.`);
  }
  if (target === "preview") {
    const output = `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`;
    if (/(?:branch|git)/i.test(output) && /PARTICIPANT_(?:PIN|SESSION_SECRET)/i.test(output)) {
      log(
        "A participant auth variable has a branch-specific Preview override. Review it in Vercel; syncing this target does not change that branch override.",
      );
    }
  }

  const failures = [];
  for (const [key, value] of [
    [KEYS[0], pair.pin],
    [KEYS[1], pair.secret],
  ]) {
    const result = runCli(
      ["env", "add", key, target, "--force", "--sensitive"],
      `${value}\n`,
      spawn,
    );
    if (resultFailed(result)) failures.push(key);
  }
  if (failures.length)
    throw new Error(
      `Vercel env upsert failed for ${failures.join(", ")}; rerun sync with the same saved pair to reconcile it.`,
    );
  log(
    "Both participant auth variables were upserted. Start a new deployment separately for the changes to take effect.",
  );
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (
    command === "generate" &&
    rest.every((flag) => flag === "--rotate" || flag === "--sync-production") &&
    new Set(rest).size === rest.length
  ) {
    return {
      command,
      rotate: rest.includes("--rotate"),
      syncProduction: rest.includes("--sync-production"),
    };
  }
  if (command === "sync") {
    if (rest.length === 2 && rest[0] === "--target") return { command, target: rest[1] };
    if (rest.length === 0) return { command, target: undefined };
  }
  throw new Error(
    "Usage: pnpm participant-auth generate [--rotate] [--sync-production] | sync --target production|preview",
  );
}

export async function main(args = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  try {
    const options = parseArgs(args);
    if (options.command === "generate") {
      const prompt = io.promptPin ?? promptHiddenLine;
      const pin = await prompt("Enter the four-digit participant PIN: ");
      const confirmation = await prompt("Confirm the four-digit participant PIN: ");
      if (pin !== confirmation) throw new Error("PIN entries do not match.");
      const writeOptions = Object.assign({ rotate: options.rotate, pin }, io.writeOptions);
      await writePair(writeOptions);
      log(
        "Participant auth pair saved to .env.local with mode 0600. The session secret is not displayed.",
      );
      if (options.syncProduction) {
        try {
          await syncPair(
            Object.assign(
              { target: "production", envPath: writeOptions.envPath, log },
              io.syncOptions,
            ),
          );
        } catch (error) {
          throw new Error(
            `${error.message} The new pair is saved in .env.local; rerun \`pnpm participant-auth sync --target production\` after fixing the sync issue.`,
          );
        }
      }
      return 0;
    }
    await syncPair(Object.assign({ target: options.target, log }, io.syncOptions));
    return 0;
  } catch (error) {
    (io.error ?? console.error)(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
