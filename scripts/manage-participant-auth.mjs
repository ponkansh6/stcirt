#!/usr/bin/env node
import { randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const PROFILES = {
  participant: {
    label: "participant",
    keys: ["PARTICIPANT_PIN", "PARTICIPANT_SESSION_SECRET"],
  },
  admin: {
    label: "admin",
    keys: ["ADMIN_PRESENTATION_PIN", "ADMIN_PRESENTATION_SESSION_SECRET"],
  },
};

/** @typedef {{ profile?: "participant" | "admin", envPath?: string, rotate?: boolean, pin?: string, pinFactory?: () => string, secretFactory?: () => string }} WritePairOptions */
/** @typedef {{ status: number | null, error?: Error, stdout?: string | null, stderr?: string | null }} CliResult */
/** @typedef {(command: string, args: string[], options?: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => CliResult} CliSpawn */
/** @typedef {{ profile?: "participant" | "admin", target?: string, envPath?: string, projectPath?: string, spawn?: CliSpawn, log?: (message: string) => void }} SyncPairOptions */

export function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const closing = value.indexOf(quote, 1);
      const remainder = closing === -1 ? "" : value.slice(closing + 1).trimStart();
      if (closing !== -1 && (!remainder || remainder.startsWith("#"))) {
        value = value.slice(1, closing);
        if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    value = value.replace(/\\\$/g, "$");
    values.set(match[1], value);
  }
  return values;
}

function serializeEnvValue(value) {
  if (!/[#\s'"`\\$]/u.test(value)) return value;
  const quote = ["'", "`", '"'].find((character) => !value.includes(character));
  if (!quote || (quote === '"' && /\\[nr]/.test(value))) {
    throw new Error(
      "The value cannot be represented safely in .env.local using Next.js dotenv syntax.",
    );
  }
  let serialized = "";
  for (const character of value) {
    if (character === "$") serialized += "\\";
    serialized += character;
  }
  return `${quote}${serialized}${quote}`;
}

export function upsertEnv(content, updates) {
  const lines = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match?.[1] === key) {
        if (!replaced) lines[i] = `${key}=${serializeEnvValue(value)}`;
        else lines[i] = `# duplicate ${key} removed by participant-auth generator`;
        replaced = true;
      }
    }
    if (!replaced) lines.push(`${key}=${serializeEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function validatePair(values, profile = "participant") {
  const selected = PROFILES[profile];
  if (!selected) throw new Error("Choose --profile participant or --profile admin.");
  const [pinKey, secretKey] = selected.keys;
  const pin = values.get(pinKey);
  const secret = values.get(secretKey);
  if (profile === "participant" && !/^\d{4}$/.test(pin ?? ""))
    throw new Error(".env.local must contain a four-digit PARTICIPANT_PIN.");
  if (profile === "admin" && (!pin || pin.length > 128 || /[\r\n\u2028\u2029]/u.test(pin)))
    throw new Error(".env.local must contain an ADMIN_PRESENTATION_PIN of 1 to 128 characters.");
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`.env.local must contain a ${secretKey} of at least 32 bytes.`);
  }
  return { pin, secret };
}

/** @param {string} prompt @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [io] */
export function promptHiddenLine(
  prompt,
  { input = process.stdin, output = process.stderr, profile = "participant" } = {},
) {
  const isValid =
    profile === "admin"
      ? (value) => value.length >= 1 && value.length <= 128 && !/[\u2028\u2029]/u.test(value)
      : (value) => /^\d{4}$/.test(value);
  const maxLength = profile === "admin" ? 128 : 4;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Generating auth values requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    let invalid = false;
    const decoder = new TextDecoder();
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      const decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (const character of decoded) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("PIN entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          if (invalid || !isValid(value)) {
            reject(
              new Error(
                profile === "admin"
                  ? "Admin PIN must contain 1 to 128 characters."
                  : "PIN must contain exactly four ASCII digits.",
              ),
            );
          } else {
            resolve(value);
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (/\p{Cc}/u.test(character)) {
          invalid = true;
          continue;
        }
        if (
          (profile === "admin" || (character >= "0" && character <= "9")) &&
          value.length + character.length <= maxLength &&
          !invalid
        ) {
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
  profile = "participant",
  envPath = ENV_PATH,
  rotate = false,
  pin: requestedPin,
  pinFactory,
  secretFactory,
} = {}) {
  const selected = PROFILES[profile];
  if (!selected) throw new Error("Choose --profile participant or --profile admin.");
  const [pinKey, secretKey] = selected.keys;
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read .env.local.");
  }
  const current = parseEnv(content);
  if (!rotate && selected.keys.some((key) => current.has(key))) {
    throw new Error(
      `${selected.label[0].toUpperCase()}${selected.label.slice(1)} auth values already exist. Use --rotate to replace them deliberately.`,
    );
  }
  const pin =
    requestedPin ?? (pinFactory ?? (() => randomInt(0, 10_000).toString().padStart(4, "0")))();
  if (profile === "participant" && !/^\d{4}$/.test(pin))
    throw new Error("PIN must contain exactly four ASCII digits.");
  if (profile === "admin" && (!pin || pin.length > 128 || /[\r\n\u2028\u2029]/u.test(pin)))
    throw new Error("Admin PIN must contain 1 to 128 characters.");
  const secret = (secretFactory ?? (() => randomBytes(32).toString("base64url")))();
  const updated = upsertEnv(content, { [pinKey]: pin, [secretKey]: secret });
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
  profile = "participant",
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
  const pair = validatePair(values, profile);
  const selected = PROFILES[profile];
  const [pinKey, secretKey] = selected.keys;
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
    if (/(?:branch|git)/i.test(output) && new RegExp(selected.keys.join("|"), "i").test(output)) {
      log(
        `A ${selected.label} auth variable has a branch-specific Preview override. Review it in Vercel; syncing this target does not change that branch override.`,
      );
    }
  }

  const failures = [];
  for (const [key, value] of [
    [pinKey, pair.pin],
    [secretKey, pair.secret],
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
    `Both ${selected.label} auth variables were upserted. Start a new deployment separately for the changes to take effect.`,
  );
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (command === "generate" || command === "sync") {
    const options = { command, profile: "participant" };
    let profileSelected = false;
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (
        flag === "--profile" &&
        !profileSelected &&
        rest[index + 1] &&
        !rest[index + 1].startsWith("--")
      ) {
        options.profile = rest[++index];
        profileSelected = true;
      } else if (command === "generate" && flag === "--rotate" && !options.rotate) {
        options.rotate = true;
      } else if (
        command === "generate" &&
        flag === "--sync-production" &&
        !options.syncProduction
      ) {
        options.syncProduction = true;
      } else if (
        command === "sync" &&
        flag === "--target" &&
        !options.target &&
        rest[index + 1] &&
        !rest[index + 1].startsWith("--")
      ) {
        options.target = rest[++index];
      } else {
        throw new Error(
          "Usage: pnpm participant-auth generate [--profile participant|admin] [--rotate] [--sync-production] | sync [--profile participant|admin] --target production|preview",
        );
      }
    }
    if (!PROFILES[options.profile])
      throw new Error("Choose --profile participant or --profile admin.");
    if (command === "sync" && !options.target)
      throw new Error(
        "Usage: pnpm participant-auth sync [--profile participant|admin] --target production|preview",
      );
    return options;
  }
  throw new Error(
    "Usage: pnpm participant-auth generate [--profile participant|admin] [--rotate] [--sync-production] | sync [--profile participant|admin] --target production|preview",
  );
}

export async function main(args = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  try {
    const options = parseArgs(args);
    if (options.command === "generate") {
      const prompt =
        io.promptPin ?? ((message) => promptHiddenLine(message, { profile: options.profile }));
      const promptMessage =
        options.profile === "admin"
          ? "Enter the admin PIN (1 to 128 characters): "
          : "Enter the four-digit participant PIN: ";
      const pin = await prompt(promptMessage);
      const confirmation = await prompt(
        options.profile === "admin"
          ? "Confirm the admin PIN: "
          : "Confirm the four-digit participant PIN: ",
      );
      if (pin !== confirmation) throw new Error("PIN entries do not match.");
      const writeOptions = Object.assign(
        { profile: options.profile, rotate: options.rotate, pin },
        io.writeOptions,
      );
      await writePair(writeOptions);
      log(
        `${options.profile === "admin" ? "Admin" : "Participant"} auth pair saved to .env.local with mode 0600. The session secret is not displayed.`,
      );
      if (options.syncProduction) {
        try {
          await syncPair(
            Object.assign(
              {
                profile: options.profile,
                target: "production",
                envPath: writeOptions.envPath,
                log,
              },
              io.syncOptions,
            ),
          );
        } catch (error) {
          const profileFlag = options.profile === "admin" ? "--profile admin " : "";
          throw new Error(
            `${error.message} The new pair is saved in .env.local; rerun \`pnpm participant-auth sync ${profileFlag}--target production\` after fixing the sync issue.`,
          );
        }
      }
      return 0;
    }
    await syncPair(
      Object.assign({ profile: options.profile, target: options.target, log }, io.syncOptions),
    );
    return 0;
  } catch (error) {
    (io.error ?? console.error)(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
