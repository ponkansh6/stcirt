import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  main,
  parseEnv,
  promptHiddenLine,
  syncPair,
  upsertEnv,
  validatePair,
  writePair,
} from "../../scripts/manage-participant-auth.mjs";

const testRequire = createRequire(import.meta.url);
const nextRequire = createRequire(testRequire.resolve("next"));
const { processEnv, resetEnv } = nextRequire("@next/env") as {
  processEnv: (
    files: Array<{ path: string; contents: string; env: Record<string, string> }>,
    directory: string,
    logger: { error: () => void },
    forceReload: boolean,
  ) => [Record<string, string>, Record<string, string>];
  resetEnv: () => void;
};

const directories: string[] = [];

function fakeTerminal(isTTY = true) {
  const input = Object.assign(new EventEmitter(), {
    isTTY,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = { write: vi.fn(() => true) };
  return { input, output };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "participant-auth-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("participant auth management", () => {
  it("accepts four ASCII digits on Enter with terminal echo disabled", async () => {
    const { input, output } = fakeTerminal();
    const pending = promptHiddenLine("PIN: ", {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(input.resume).toHaveBeenCalledOnce();
    input.emit("data", Buffer.from("0042\r"));

    await expect(pending).resolves.toBe("0042");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(output.write.mock.calls.flat().join("")).toBe("PIN: \n");
    expect(output.write.mock.calls.flat().join("")).not.toContain("0042");
  });

  it.each(["12x4\r", "１２３４\r"])("rejects non-ASCII PIN input %s", async (typed) => {
    const { input, output } = fakeTerminal();
    const pending = promptHiddenLine("PIN: ", {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    input.emit("data", Buffer.from(typed));

    await expect(pending).rejects.toThrow("exactly four ASCII digits");
    expect(output.write.mock.calls.flat().join("")).not.toContain(typed.trim());
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("rejects non-TTY input without including any PIN in output or the error", async () => {
    const { input, output } = fakeTerminal(false);
    let message = "";
    try {
      await promptHiddenLine("PIN: ", {
        input: input as unknown as NodeJS.ReadStream,
        output: output as unknown as NodeJS.WriteStream,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("interactive terminal");
    expect(message).not.toContain("0042");
    expect(output.write).not.toHaveBeenCalled();
    expect(input.setRawMode).not.toHaveBeenCalled();
  });

  it("uses a twice-confirmed user-selected PIN without displaying it", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const promptPin = vi.fn().mockResolvedValueOnce("0007").mockResolvedValueOnce("0007");
    const log = vi.fn();
    const error = vi.fn();

    const status = await main(["generate"], {
      promptPin,
      log,
      error,
      writeOptions: { envPath, secretFactory: () => "s".repeat(43) },
    });

    expect(status).toBe(0);
    expect(promptPin).toHaveBeenCalledTimes(2);
    expect(parseEnv(await readFile(envPath, "utf8")).get("PARTICIPANT_PIN")).toBe("0007");
    expect(log.mock.calls.flat().join(" ")).not.toContain("0007");
    expect(error).not.toHaveBeenCalled();
  });

  it("generates and syncs the pair to Production without starting a deployment", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    await writeFile(projectPath, JSON.stringify({ projectName: "stcirt-prod" }));
    const promptPin = vi.fn().mockResolvedValueOnce("0007").mockResolvedValueOnce("0007");
    const calls: Array<{ args: string[]; input?: string }> = [];
    const spawn = vi.fn(
      (_command: string, args: string[], options?: SpawnSyncOptionsWithStringEncoding) => {
        calls.push({ args, input: options?.input as string | undefined });
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    const status = await main(["generate", "--sync-production"], {
      promptPin,
      error: vi.fn(),
      writeOptions: { envPath, secretFactory: () => "s".repeat(43) },
      syncOptions: { projectPath, spawn },
    });

    expect(status).toBe(0);
    expect(calls.map(({ args }) => args)).toEqual([
      ["whoami"],
      ["env", "ls", "production"],
      ["env", "add", "PARTICIPANT_PIN", "production", "--force", "--sensitive"],
      ["env", "add", "PARTICIPANT_SESSION_SECRET", "production", "--force", "--sensitive"],
    ]);
    expect(calls.every(({ args }) => args[0] !== "deploy")).toBe(true);
    expect(calls[2].input).toBe("0007\n");
    expect(calls[3].input).toBe(`${"s".repeat(43)}\n`);
  });

  it("returns nonzero and gives the Production sync command when combined sync fails", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    await writeFile(projectPath, JSON.stringify({ projectId: "project-id" }));
    const promptPin = vi.fn().mockResolvedValueOnce("0007").mockResolvedValueOnce("0007");
    const error = vi.fn();
    const spawn = vi.fn((_command: string, args: string[]) => ({
      status: args[1] === "add" && args[2] === "PARTICIPANT_SESSION_SECRET" ? 1 : 0,
      stdout: "",
      stderr: "",
    }));

    const status = await main(["generate", "--sync-production"], {
      promptPin,
      error,
      writeOptions: { envPath, secretFactory: () => "s".repeat(43) },
      syncOptions: { projectPath, spawn },
    });

    expect(status).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain(
      "pnpm participant-auth sync --target production",
    );
    expect(error.mock.calls.flat().join(" ")).toContain("saved in .env.local");
    expect(spawn.mock.calls.every(([, args]) => args[0] !== "deploy")).toBe(true);
  });

  it("rejects mismatched PIN confirmation without writing the pair or exposing input", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const promptPin = vi.fn().mockResolvedValueOnce("1234").mockResolvedValueOnce("4321");
    const error = vi.fn();

    const status = await main(["generate"], {
      promptPin,
      error,
      writeOptions: { envPath },
    });

    expect(status).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("do not match");
    expect(error.mock.calls.flat().join(" ")).not.toContain("1234");
    expect(error.mock.calls.flat().join(" ")).not.toContain("4321");
    await expect(readFile(envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated env values, keeps leading zeroes, and writes owner-only atomically", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    await writeFile(envPath, "TURSO_AUTH_TOKEN=keep-me\nPARTICIPANT_PIN=old1\nCUSTOM=value\n", {
      mode: 0o644,
    });

    await expect(
      writePair({ envPath, pinFactory: () => "0007", secretFactory: () => "s".repeat(43) }),
    ).rejects.toThrow("--rotate");
    const result = await writePair({
      envPath,
      rotate: true,
      pinFactory: () => "0007",
      secretFactory: () => "s".repeat(43),
    });

    const contents = await readFile(envPath, "utf8");
    expect(result.pin).toBe("0007");
    expect(parseEnv(contents).get("TURSO_AUTH_TOKEN")).toBe("keep-me");
    expect(parseEnv(contents).get("CUSTOM")).toBe("value");
    expect(parseEnv(contents).get("PARTICIPANT_PIN")).toBe("0007");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("creates admin values without replacing participant values and syncs only the admin profile", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    const participantPair = `PARTICIPANT_PIN=0042\nPARTICIPANT_SESSION_SECRET=${"p".repeat(43)}\n`;
    await writeFile(envPath, participantPair);
    await writeFile(projectPath, JSON.stringify({ projectName: "stcirt" }));

    const adminPin = " host #1 'quoted' \"double\" \\ value $HOME ";
    const adminSecret = "a".repeat(43);
    await writePair({
      profile: "admin",
      envPath,
      pin: adminPin,
      secretFactory: () => adminSecret,
    });
    const values = parseEnv(await readFile(envPath, "utf8"));
    expect(values.get("PARTICIPANT_PIN")).toBe("0042");
    expect(values.get("ADMIN_PRESENTATION_PIN")).toBe(adminPin);
    expect(values.get("ADMIN_PRESENTATION_SESSION_SECRET")).toBe(adminSecret);
    expect(() => validatePair(values, "admin")).not.toThrow();
    expect(() =>
      validatePair(
        new Map([
          ["ADMIN_PRESENTATION_PIN", "x".repeat(129)],
          ["ADMIN_PRESENTATION_SESSION_SECRET", "a".repeat(43)],
        ]),
        "admin",
      ),
    ).toThrow("1 to 128");

    try {
      const [, parsedEnv] = processEnv(
        [{ path: ".env.local", contents: await readFile(envPath, "utf8"), env: {} }],
        directory,
        { error: vi.fn() },
        true,
      );
      expect(parsedEnv?.ADMIN_PRESENTATION_PIN).toBe(adminPin);
      expect(parsedEnv?.ADMIN_PRESENTATION_SESSION_SECRET).toBe(adminSecret);
    } finally {
      resetEnv();
    }

    const calls: Array<{ args: string[]; input?: string }> = [];
    const spawn = vi.fn(
      (_command: string, args: string[], options?: SpawnSyncOptionsWithStringEncoding) => {
        calls.push({ args, input: options?.input as string | undefined });
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    const log = vi.fn();
    await syncPair({ profile: "admin", target: "preview", envPath, projectPath, spawn, log });
    expect(calls.map(({ args }) => args)).toContainEqual([
      "env",
      "add",
      "ADMIN_PRESENTATION_PIN",
      "preview",
      "--force",
      "--sensitive",
    ]);
    expect(calls.map(({ args }) => args)).toContainEqual([
      "env",
      "add",
      "ADMIN_PRESENTATION_SESSION_SECRET",
      "preview",
      "--force",
      "--sensitive",
    ]);
    expect(calls.some(({ args }) => args.includes("PARTICIPANT_PIN"))).toBe(false);
    expect(calls.find(({ args }) => args[2] === "ADMIN_PRESENTATION_PIN")?.input).toBe(
      `${adminPin}\n`,
    );
    expect(log.mock.calls.flat().join(" ")).toContain("new deployment");
    expect(log.mock.calls.flat().join(" ")).not.toContain(adminPin);
    expect(log.mock.calls.flat().join(" ")).not.toContain(adminSecret);
  });

  it("refuses admin PINs that cannot be represented unambiguously in Next dotenv syntax", () => {
    expect(() =>
      upsertEnv("", {
        ADMIN_PRESENTATION_PIN: "single' double\" backtick`",
      }),
    ).toThrow("cannot be represented safely");
  });

  it("selects the admin profile from the CLI and confirms a full-length non-participant PIN", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const adminPin = "式典管理者-é";
    const promptPin = vi.fn().mockResolvedValueOnce(adminPin).mockResolvedValueOnce(adminPin);
    const log = vi.fn();
    const error = vi.fn();

    const status = await main(["generate", "--profile", "admin"], {
      promptPin,
      log,
      error,
      writeOptions: { envPath, secretFactory: () => "a".repeat(43) },
    });

    expect(status).toBe(0);
    expect(promptPin.mock.calls[0][0]).toContain("admin PIN");
    expect(parseEnv(await readFile(envPath, "utf8")).get("ADMIN_PRESENTATION_PIN")).toBe(adminPin);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain(adminPin);
  });

  it("upserts pair keys without changing unrelated lines", () => {
    const content = "# comment\nTURSO_DATABASE_URL=libsql://db\nPARTICIPANT_PIN=0001\n";
    const updated = upsertEnv(content, {
      PARTICIPANT_PIN: "0099",
      PARTICIPANT_SESSION_SECRET: "z".repeat(43),
    });
    expect(updated).toContain("# comment\nTURSO_DATABASE_URL=libsql://db");
    expect(parseEnv(updated).get("PARTICIPANT_PIN")).toBe("0099");
    expect(parseEnv(updated).get("PARTICIPANT_SESSION_SECRET")).toBe("z".repeat(43));
  });

  it("validates pair format", () => {
    expect(() =>
      validatePair(
        new Map([
          ["PARTICIPANT_PIN", "１２３４"],
          ["PARTICIPANT_SESSION_SECRET", "x".repeat(32)],
        ]),
      ),
    ).toThrow();
    expect(() =>
      validatePair(
        new Map([
          ["PARTICIPANT_PIN", "1234"],
          ["PARTICIPANT_SESSION_SECRET", "short"],
        ]),
      ),
    ).toThrow();
  });

  it("sends sensitive values only through stdin for an explicit Production target", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    const secret = "private-session-secret-value-of-at-least-32-bytes";
    await writeFile(envPath, `PARTICIPANT_PIN=0042\nPARTICIPANT_SESSION_SECRET=${secret}\n`);
    await writeFile(projectPath, JSON.stringify({ projectName: "stcirt-prod" }));
    const calls: Array<{ args: string[]; input?: string }> = [];
    const spawn = vi.fn(
      (_command: string, args: string[], options?: SpawnSyncOptionsWithStringEncoding) => {
        calls.push({ args, input: options?.input as string | undefined });
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    const log = vi.fn();

    await syncPair({ target: "production", envPath, projectPath, spawn, log });

    expect(calls.map(({ args }) => args)).toEqual([
      ["whoami"],
      ["env", "ls", "production"],
      ["env", "add", "PARTICIPANT_PIN", "production", "--force", "--sensitive"],
      ["env", "add", "PARTICIPANT_SESSION_SECRET", "production", "--force", "--sensitive"],
    ]);
    expect(calls[2].input).toBe("0042\n");
    expect(calls[3].input).toBe(`${secret}\n`);
    expect(calls.flatMap(({ args }) => args).join(" ")).not.toContain(secret);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("warns about detected branch-specific Preview overrides and does not deploy", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    await writeFile(
      envPath,
      `PARTICIPANT_PIN=0042\nPARTICIPANT_SESSION_SECRET=${"s".repeat(43)}\n`,
    );
    await writeFile(projectPath, JSON.stringify({ projectId: "project-id" }));
    const calls: string[][] = [];
    const spawn = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      return {
        status: 0,
        stdout: args[0] === "env" && args[1] === "ls" ? "PARTICIPANT_PIN branch: release" : "",
        stderr: "",
      };
    });
    const log = vi.fn();

    await syncPair({ target: "preview", envPath, projectPath, spawn, log });

    expect(calls).toContainEqual(["env", "ls", "preview"]);
    expect(log.mock.calls.flat().join(" ")).toContain("branch-specific Preview override");
    expect(calls.every((args) => args[0] !== "deploy")).toBe(true);
  });

  it("stops before upsert when the selected Vercel environment cannot be inspected", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    await writeFile(
      envPath,
      `PARTICIPANT_PIN=0042\nPARTICIPANT_SESSION_SECRET=${"s".repeat(43)}\n`,
    );
    await writeFile(projectPath, JSON.stringify({ projectId: "project-id" }));
    const calls: string[][] = [];
    const secret = "private CLI error output";
    const spawn = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      return {
        status: args[0] === "env" && args[1] === "ls" ? 1 : 0,
        stdout: secret,
        stderr: secret,
      };
    });
    const log = vi.fn();

    await expect(
      syncPair({ target: "production", envPath, projectPath, spawn, log }),
    ).rejects.toThrow("environment preflight failed");

    expect(calls).toEqual([["whoami"], ["env", "ls", "production"]]);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("rejects Development and reports partial upsert failure without exposing CLI output", async () => {
    const directory = await temporaryDirectory();
    const envPath = join(directory, ".env.local");
    const projectPath = join(directory, "project.json");
    const secret = "s".repeat(43);
    await writeFile(envPath, `PARTICIPANT_PIN=0042\nPARTICIPANT_SESSION_SECRET=${secret}\n`);
    await writeFile(projectPath, JSON.stringify({ projectId: "project-id" }));
    const spawn = vi.fn((_command: string, args: string[]) => ({
      status: args[1] === "add" && args[2] === "PARTICIPANT_SESSION_SECRET" ? 1 : 0,
      stdout: secret,
      stderr: secret,
    }));
    const log = vi.fn();

    await expect(
      syncPair({ target: "development", envPath, projectPath, spawn, log }),
    ).rejects.toThrow("not supported");
    expect(spawn).not.toHaveBeenCalled();
    await expect(
      syncPair({ target: "production", envPath, projectPath, spawn, log }),
    ).rejects.toThrow("PARTICIPANT_SESSION_SECRET");
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});
