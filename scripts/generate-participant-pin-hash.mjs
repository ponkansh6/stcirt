import { randomBytes, randomInt, scryptSync } from "node:crypto";

const pin = randomInt(0, 10_000).toString().padStart(4, "0");
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
console.info(`Event PIN to share securely: ${pin}`);
console.info("Set PARTICIPANT_SESSION_SECRET to a separate random value of at least 32 bytes.");
