import { randomBytes, scryptSync } from "node:crypto";

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("A terminal is required to enter the PIN securely."));
      return;
    }

    let acceptingInput = false;
    let settled = false;
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      input.off("close", onClose);
      process.off("SIGINT", onSigint);
      input.pause();
      try {
        input.setRawMode(false);
      } catch {
        // The terminal may already be closed; cleanup must still complete.
      }
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write("\n");
      reject(new Error(message));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write("\n");
      resolve(value);
    };

    const onData = (chunk) => {
      if (!acceptingInput || settled) return;

      const text = chunk.toString("utf8");
      const newlineIndex = text.search(/[\r\n]/);
      const enteredText = newlineIndex === -1 ? text : text.slice(0, newlineIndex);

      for (const character of enteredText) {
        if (character === "\u0003" || character === "\u0004") {
          fail("PIN entry cancelled.");
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }

      if (newlineIndex !== -1) {
        // Anything after Enter in this chunk is intentionally discarded.
        finish();
      }
    };

    const onError = () => fail("Unable to read PIN from the terminal.");
    const onEnd = () => fail("Terminal input ended before PIN entry was complete.");
    const onClose = () => fail("Terminal input closed before PIN entry was complete.");
    const onSigint = () => fail("PIN entry cancelled.");

    input.on("data", onData);
    input.on("error", onError);
    input.on("end", onEnd);
    input.on("close", onClose);
    process.once("SIGINT", onSigint);

    // Keep input inactive for one event-loop turn, then discard anything left
    // from the previous prompt before accepting a new PIN entry.
    input.pause();
    new Promise((ready) => setImmediate(ready)).then(() => {
      if (settled) return;
      try {
        while (input.read() !== null) {}
        input.setRawMode(true);
        process.stderr.write(prompt);
        acceptingInput = true;
        input.resume();
      } catch {
        fail("Unable to read PIN from the terminal.");
      }
    });
  });
}

try {
  const pin = await readHidden("Enter the shared participant PIN (4 digits): ");
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("PIN must contain exactly four ASCII digits.");
  }

  const confirmation = await readHidden("Confirm the participant PIN: ");
  if (confirmation !== pin) {
    throw new Error("PIN entries do not match.");
  }

  const salt = randomBytes(16);
  const pepper = randomBytes(32).toString("hex");
  const digest = scryptSync(`${pin}:${pepper}`, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });

  console.info(`PARTICIPANT_PIN_HASH=scrypt$${salt.toString("hex")}$${digest.toString("hex")}`);
  console.info(`PARTICIPANT_PIN_PEPPER=${pepper}`);
  console.info("Set PARTICIPANT_SESSION_SECRET to a separate random value of at least 32 bytes.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
