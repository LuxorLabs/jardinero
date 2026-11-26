import { resolve } from 'node:path';

const envFile = process.env.ENV_FILE ?? '.env';
const envPath = resolve(process.cwd(), envFile);

// A variable already set in the environment wins over the file.
try {
  process.loadEnvFile(envPath);
} catch {
  // missing or unreadable file; boot on the real environment
}
