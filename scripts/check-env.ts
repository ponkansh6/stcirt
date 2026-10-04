import fs from "fs";
import path from "path";

const envPath = path.resolve(process.cwd(), ".env.local");

if (!fs.existsSync(envPath)) {
  console.error("Error: .env.local file does not exist.");
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, "utf-8");
const requiredKeys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
const missingKeys: string[] = [];

for (const key of requiredKeys) {
  const regex = new RegExp(`^\\s*${key}\\s*=`, "m");
  if (!regex.test(envContent)) {
    missingKeys.push(key);
  }
}

if (missingKeys.length > 0) {
  console.error(
    `Error: Missing required environment variables in .env.local: ${missingKeys.join(", ")}`,
  );
  process.exit(1);
}

console.log("Success: All required environment variables are present in .env.local.");
process.exit(0);
