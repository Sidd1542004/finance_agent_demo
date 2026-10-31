// Create an administrator account from a terminal.
//
//   npm run create-admin --prefix server -- --email you@example.com --name "Your Name"
//
// The password is read from ADMIN_PASSWORD if set, otherwise typed at a hidden
// prompt. It is never printed. Uses MONGODB_URI (server/.env or the environment),
// so it can set up the Vercel database from your machine.
//
// --roles reviewer,approver,payer adds roles on top of admin (optional).

import dns from 'node:dns';
import mongoose from 'mongoose';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { safeUri, redactSecrets } from '../safeUri.js';
import { createUser } from '../services/users.js';
if (config.dnsServers.length) {
  dns.setServers(config.dnsServers);
}
function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, roles: { type: 'string' } } });
  if (!values.email || !values.name) {
    console.error('Usage: npm run create-admin --prefix server -- --email you@example.com --name "Your Name" [--roles approver,payer]');
    process.exit(2);
  }
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error('Set ADMIN_PASSWORD, or run this in a terminal to type the password.');
      process.exit(2);
    }
    password = await hiddenPrompt('Password (at least 12 characters): ');
    const again = await hiddenPrompt('Password again: ');
    if (password !== again) {
      console.error('The passwords do not match.');
      process.exit(2);
    }
  }
  const extra = String(values.roles || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  } catch (err) {
    console.error(`Could not connect to MongoDB at ${safeUri(config.mongoUri)}: ${redactSecrets(err?.message)}`);
    process.exit(1);
  }
  try {
    const user = await createUser({ email: values.email, name: values.name, password, roles: ['admin', ...extra] });
    console.log(`Administrator created: ${user.name} <${user.email}> (${user.roles.join(', ')}).`);
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

await main();
