import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = process.env.ENV_FILE ?? '.env';
const envPath = resolve(process.cwd(), envFile);

// process.loadEnvFile leaves variables already set in the environment alone,
// matching dotenv's default; the existsSync guard keeps a missing file non-fatal.
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
