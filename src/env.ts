import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const envFile = process.env.ENV_FILE ?? '.env';
const envPath = resolve(process.cwd(), envFile);

if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}
