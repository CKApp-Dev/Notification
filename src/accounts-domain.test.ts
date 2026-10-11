import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageAccount, deriveAccess, normalizeEmail, validateInvite } from './accounts-domain.ts';
import type { AccessInput, AccountRole } from './accounts-domain.ts';

const member: AccessInput = {
  adminClaim: false,
  accountManagerClaim: false,
  email: 'Member.Name+news@example.com',
  emailVerified: true,
  signInProvider: 'google.com',
  invitation: { email: 'member.name+news@example.com', enabled: true },
};

test('email normalization trims and lowercases while preserving dots and plus aliases', () => {
  assert.equal(normalizeEmail('  Member.Name+NEWS@Example.COM  '), 'member.name+news@example.com');
  const invite = validateInvite('  Member.Name+NEWS@Example.COM  ', '  公告編輯  ', 'owner@example.com');
  assert.deepEqual(invite.errors, {});
  assert.deepEqual(invite.data, {
    email: 'member.name+news@example.com', displayName: '公告編輯', enabled: true, role: 'admin',
  });
  assert.notEqual(normalizeEmail('first.last@gmail.com'), normalizeEmail('firstlast@gmail.com'));
  assert.notEqual(normalizeEmail('member+news@gmail.com'), normalizeEmail('member@gmail.com'));
});

test('invites reject document paths, control characters, invalid syntax, and oversized emails', () => {
  for (const email of [
    '', 'member', 'member@example', 'member@.example.com', 'member@example..com',
    'member@-example.com', 'member@example-.com', 'member@example.com.',
    'member/other@example.com', 'members/member@example.com', 'member@example.com/other',
    'member\\other@example.com', 'member name@example.com', 'member@example .com',
    'member\t@example.com', 'member@example.com\n', 'member\r@example.com',
    'member\u0000@example.com', 'member\u007f@example.com', 'member@@example.com',
    'member<script>@example.com', '"member"@example.com', '.member@example.com',
    'member.@example.com', 'mem..ber@example.com', `${'m'.repeat(243)}@example.com`,
  ]) {
    assert.ok(validateInvite(email, '', null).errors.email, JSON.stringify(email));
    assert.equal(deriveAccess({ ...member, email }).invitationEmail, null, JSON.stringify(email));
  }
  const maximumLength = `${'m'.repeat(242)}@example.com`;
  assert.equal(maximumLength.length, 254);
  assert.deepEqual(validateInvite(maximumLength, '', null).errors, {});
});

test('self-invites compare normalized emails without canonicalizing Google aliases', () => {
  assert.ok(validateInvite(' OWNER@EXAMPLE.COM ', '', ' owner@example.com ').errors.email);
  assert.deepEqual(validateInvite('owner+editor@example.com', '', 'owner@example.com').errors, {});
  assert.deepEqual(validateInvite('owner.name@gmail.com', '', 'ownername@gmail.com').errors, {});
});

test('display name is optional, trimmed, and bounded to 120 characters', () => {
  assert.equal(validateInvite('member@example.com', '   ', null).data.displayName, '');
  assert.deepEqual(validateInvite('member@example.com', `  ${'a'.repeat(120)}  `, null).errors, {});
  assert.ok(validateInvite('member@example.com', 'a'.repeat(121), null).errors.displayName);
});

test('invitations permit admin and super admin roles but never owner or invalid roles', () => {
  for (const role of ['admin', 'super_admin'] as const) {
    const invite = validateInvite('member@example.com', '', null, role);
    assert.deepEqual(invite.errors, {});
    assert.equal(invite.data.role, role);
  }
  for (const role of ['owner', '', 'SUPER_ADMIN', null, true, {}]) {
    const invite = validateInvite(
      'member@example.com', '', null, role as Parameters<typeof validateInvite>[3],
    );
    assert.ok(invite.errors.role, JSON.stringify(role));
  }
});

test('verified Google members gain authoring only from their exact enabled invitation', () => {
  assert.deepEqual(deriveAccess(member), {
    isAdmin: true, canManageAccounts: false, isOwner: false, role: 'admin',
    invitationEmail: 'member.name+news@example.com',
  });
  for (const invitation of [
    null,
    { email: 'member.name+news@example.com', enabled: false },
    { email: 'member.name@example.com', enabled: true },
    { email: 'membername+news@example.com', enabled: true },
    { email: 'Member.Name+news@example.com', enabled: true },
    { email: 'someone.else@example.com', enabled: true },
  ]) {
    assert.equal(deriveAccess({ ...member, invitation }).isAdmin, false);
  }
});

test('invitation lookup requires verified Google identity with a valid email', () => {
  for (const identity of [
    { emailVerified: false },
    { signInProvider: 'password' },
    { signInProvider: null },
    { email: null },
    { email: 'member@example' },
  ]) {
    assert.deepEqual(deriveAccess({ ...member, ...identity }), {
      isAdmin: false, canManageAccounts: false, isOwner: false, role: null, invitationEmail: null,
    });
  }
  assert.equal(deriveAccess({ ...member, invitation: null }).invitationEmail, 'member.name+news@example.com');
});

test('only trusted owner claims or the legacy pair root owners independently of membership', () => {
  for (const claims of [
    { roleClaim: 'owner', adminClaim: false, accountManagerClaim: false },
    { adminClaim: true, accountManagerClaim: true },
  ]) {
    for (const invitation of [null, { email: member.email!, enabled: false }]) {
      assert.deepEqual(deriveAccess({
        ...member, ...claims, invitation,
        email: null, emailVerified: false, signInProvider: 'password',
      }), {
        isAdmin: true, canManageAccounts: true, isOwner: true, role: 'owner', invitationEmail: null,
      });
    }
  }
});

test('owner claims and legacy root claims require exact values', () => {
  for (const adminClaim of [false, null, undefined, 1, 'true', {}]) {
    const invited = deriveAccess({ ...member, adminClaim, accountManagerClaim: true });
    assert.equal(invited.isAdmin, true);
    assert.equal(invited.canManageAccounts, false);
    assert.equal(invited.isOwner, false);
    const uninvited = deriveAccess({ ...member, adminClaim, accountManagerClaim: true, invitation: null });
    assert.equal(uninvited.isAdmin, false);
    assert.equal(uninvited.canManageAccounts, false);
  }
  for (const accountManagerClaim of [false, null, undefined, 1, 'true', {}]) {
    assert.equal(deriveAccess({ ...member, adminClaim: true, accountManagerClaim }).canManageAccounts, false);
  }
  for (const roleClaim of ['Owner', 'admin', 'super_admin', '', true, 1, null, {}]) {
    const access = deriveAccess({ ...member, roleClaim, invitation: null });
    assert.equal(access.isAdmin, false, JSON.stringify(roleClaim));
    assert.equal(access.isOwner, false, JSON.stringify(roleClaim));
  }
});

test('enabled invitations grant only their permitted role and legacy invitations remain admins', () => {
  for (const role of [undefined, 'admin', 'super_admin']) {
    const access = deriveAccess({ ...member, invitation: { ...member.invitation!, role } });
    assert.equal(access.role, role ?? 'admin');
    assert.equal(access.isAdmin, true);
    assert.equal(access.canManageAccounts, role === 'super_admin');
    assert.equal(access.isOwner, false);
  }
  for (const role of ['owner', 'ADMIN', '', null, false, 1, {}]) {
    const access = deriveAccess({ ...member, invitation: { ...member.invitation!, role } });
    assert.equal(access.role, null, JSON.stringify(role));
    assert.equal(access.isAdmin, false, JSON.stringify(role));
    assert.equal(access.canManageAccounts, false, JSON.stringify(role));
    assert.equal(access.isOwner, false, JSON.stringify(role));
  }
});

test('deleting or disabling a nonowner membership revokes access despite stale admin claims', () => {
  for (const role of ['admin', 'super_admin'] as const) {
    const invited = {
      ...member,
      adminClaim: true,
      roleClaim: role,
      invitation: { ...member.invitation!, role },
    };
    assert.equal(deriveAccess(invited).role, role);
    for (const invitation of [null, { ...invited.invitation, enabled: false }]) {
      assert.deepEqual(deriveAccess({ ...invited, invitation }), {
        isAdmin: false, canManageAccounts: false, isOwner: false, role: null,
        invitationEmail: 'member.name+news@example.com',
      });
    }
  }
});

test('account management enforces the owner, super admin, and admin permission matrix', () => {
  const roles: Array<AccountRole | null> = ['owner', 'super_admin', 'admin', null];
  const targets: AccountRole[] = ['owner', 'super_admin', 'admin'];
  const allowed: Record<AccountRole, AccountRole[]> = {
    owner: ['super_admin', 'admin'],
    super_admin: ['admin'],
    admin: [],
  };
  for (const actorRole of roles) {
    for (const targetRole of targets) {
      assert.equal(
        canManageAccount(actorRole, targetRole, 'other@example.com', 'actor@example.com'),
        actorRole !== null && allowed[actorRole].includes(targetRole),
        `${actorRole} manages ${targetRole}`,
      );
    }
  }
});

test('all roles protect owners and reject management of the current normalized email', () => {
  for (const actorRole of ['owner', 'super_admin', 'admin', null] as const) {
    assert.equal(canManageAccount(actorRole, 'owner', 'owner@example.com', null), false);
    for (const targetRole of ['owner', 'super_admin', 'admin'] as const) {
      assert.equal(
        canManageAccount(actorRole, targetRole, ' SELF@EXAMPLE.COM ', 'self@example.com'), false,
      );
    }
  }
  assert.equal(canManageAccount('owner', 'admin', 'self+editor@example.com', 'self@example.com'), true);
});
