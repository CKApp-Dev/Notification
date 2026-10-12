'use strict';

// Keep authorization aligned with isOwner/isVerifiedGoogle/memberRole in firestore.rules.
const EMAIL_PATTERN = /^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function createAuthorizer({ verifyIdToken, readAdminAccount }) {
  if (typeof verifyIdToken !== 'function' || typeof readAdminAccount !== 'function') {
    throw new TypeError('Token verification and account lookup are required.');
  }

  return async request => {
    const header = request.headers?.authorization;
    if (typeof header !== 'string' || header.length > 8192) return 'unauthenticated';
    const bearer = /^Bearer ([^\s,]+)$/i.exec(header);
    if (!bearer || bearer[0] !== header) return 'unauthenticated';

    let token;
    try {
      // The Admin SDK validates signature, issuer, audience and expiration.
      token = await verifyIdToken(bearer[1]);
    } catch {
      return 'unauthenticated';
    }
    if (!token || typeof token !== 'object') return 'unauthenticated';
    if (token.role === 'owner' || (token.admin === true && token.accountManager === true)) {
      return 'authorized';
    }
    if (token.email_verified !== true || token.firebase?.sign_in_provider !== 'google.com'
      || typeof token.email !== 'string') return 'forbidden';

    const email = token.email.toLowerCase();
    if (email.length > 254 || email.trim() !== email || !EMAIL_PATTERN.test(email)) return 'forbidden';
    // Read on each click so disabling an account takes effect without a new ID token.
    const account = await readAdminAccount(email);
    const role = account && Object.hasOwn(account, 'role') ? account.role : 'admin';
    return account?.enabled === true && account.email === email
      && (role === 'admin' || role === 'super_admin') ? 'authorized' : 'forbidden';
  };
}

module.exports = { createAuthorizer };
