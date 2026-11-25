import { resolve } from 'node:path';

const envFile = process.env.ENV_FILE ?? '.env';
const envPath = resolve(process.cwd(), envFile);

// process.loadEnvFile leaves variables already set in the environment alone, as
// dotenv did; it throws on a missing or unreadable file, which dotenv skipped.
try {
  process.loadEnvFile(envPath);
} catch {
  // no usable env file; boot on the real environment
}
