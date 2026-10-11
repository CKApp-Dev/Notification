import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: npm run grant-admin -- --project YOUR_PROJECT_ID --email admin@example.com [--role owner|super_admin|admin] [--account-manager]';
const ROLES = ['owner', 'super_admin', 'admin'];

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254
    && /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email);
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--account-manager') {
      if (options.accountManager) throw new Error(USAGE);
      options.accountManager = true;
    } else if (['--email', '--project', '--role'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || options[flag] !== undefined) throw new Error(USAGE);
      options[flag] = value.trim();
    } else {
      throw new Error(USAGE);
    }
  }
  const email = options['--email']?.toLowerCase();
  const projectId = options['--project'];
  const role = options['--role'] ?? (options.accountManager ? 'owner' : 'admin');
  if (!validEmail(email) || !projectId || !ROLES.includes(role)
    || (options.accountManager && role !== 'owner')) throw new Error(USAGE);
  return { email, projectId, role };
}

export function isRootedOwner(claims = {}) {
  return claims.role === 'owner' || (claims.admin === true && claims.accountManager === true);
}

export function claimsForRole(claims = {}, role) {
  if (!ROLES.includes(role)) throw new Error('Unknown administrator role.');
  const next = { ...claims };
  delete next.admin;
  delete next.accountManager;
  delete next.role;
  return role === 'owner' ? { ...next, role: 'owner', admin: true, accountManager: true } : next;
}

async function writeMembership(db, serverTimestamp, user, role) {
  const email = user.email?.trim().toLowerCase();
  if (!validEmail(email)) throw new Error('An existing owner has an unsupported email; register a valid Google email before granting accounts.');
  const reference = db.collection('adminAccounts').doc(email);
  await db.runTransaction(async (transaction) => {
    const previous = (await transaction.get(reference)).data() ?? {};
    if (role !== 'owner' && previous.role === 'owner') {
      throw new Error('Owner accounts cannot be demoted with grant-admin.');
    }
    transaction.set(reference, {
      email,
      displayName: typeof previous.displayName === 'string' ? previous.displayName.slice(0, 120) : (user.displayName ?? '').slice(0, 120),
      enabled: true,
      role,
      createdAt: previous.createdAt ?? serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: typeof previous.createdBy === 'string' ? previous.createdBy : user.uid,
    });
  });
}

export async function grantRole({ auth, db, serverTimestamp }, { email, role }) {
  if (!validEmail(email) || !ROLES.includes(role)) throw new Error('Invalid administrator email or role.');
  const user = await auth.getUserByEmail(email);
  if (user.disabled || !user.emailVerified || !user.providerData.some((provider) => provider.providerId === 'google.com' && provider.email?.toLowerCase() === email)) {
    throw new Error('Administrator must first sign in with a verified, enabled Google account matching the explicit email.');
  }
  if (role !== 'owner' && isRootedOwner(user.customClaims)) {
    throw new Error('Owner accounts cannot be demoted with grant-admin.');
  }

  // Rooted claims cannot be inspected by Firestore rules. Register every existing
  // owner before enabling managers so their accounts are protected from clients.
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const existing of page.users) {
      if (isRootedOwner(existing.customClaims)) await writeMembership(db, serverTimestamp, existing, 'owner');
    }
    pageToken = page.pageToken;
  } while (pageToken);

  await writeMembership(db, serverTimestamp, user, role);
  await auth.setCustomUserClaims(user.uid, claimsForRole(user.customClaims, role));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const require = createRequire(new URL('../worker/package.json', import.meta.url));
  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault(), projectId: options.projectId });
  await grantRole({ auth: getAuth(), db: getFirestore(), serverTimestamp: () => FieldValue.serverTimestamp() }, options);
  console.log(`Granted ${options.role} to ${options.email} in ${options.projectId}. Sign out and sign in again to refresh claims. Non-owner access is controlled by the enabled account membership.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
