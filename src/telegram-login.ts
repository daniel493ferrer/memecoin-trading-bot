/**
 * One-time Telegram login for influencer signals. Saves the session to the
 * file in config.json (influencers.sessionFile). Your phone number and code
 * go only to Telegram; nothing is sent anywhere else.
 *
 *   npm run telegram-login
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import 'dotenv/config';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { ConfigSchema } from './config.js';

const config = ConfigSchema.parse(JSON.parse(fs.readFileSync('config.json', 'utf8')));
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? '';
if (!apiId || !apiHash) {
  console.error('Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env first (get them at https://my.telegram.org → API development tools).');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => rl.question('Phone number (with country code, e.g. +52...): '),
  password: () => rl.question('2FA password (if you have one): '),
  phoneCode: () => rl.question('Code Telegram sent you: '),
  onError: (err: Error) => console.error(err.message),
} as never);
const file = path.resolve(config.influencers.sessionFile);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, String(client.session.save()), { mode: 0o600 });
console.log(`Logged in. Session saved to ${file} — keep it private, it gives access to your Telegram.`);
rl.close();
await client.disconnect();
process.exit(0);
