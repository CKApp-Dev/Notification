export type AccountRole = 'owner' | 'super_admin' | 'admin';

export const ROLE_LABELS: Record<AccountRole, string> = {
  owner: 'Owner',
  super_admin: 'Super Admin',
  admin: 'Admin',
};

export interface Invitation {
  email: string;
  displayName: string;
  enabled: boolean;
  role: AccountRole;
  createdAt: Date | null;
  updatedAt: Date | null;
  createdBy: string;
}

export interface AccessInput {
  adminClaim: unknown;
  accountManagerClaim: unknown;
  roleClaim?: unknown;
  email: string | null;
  emailVerified: boolean;
  signInProvider: string | null;
  invitation: (Pick<Invitation, 'email' | 'enabled'> & { role?: unknown }) | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (/[\u0000-\u001f\u007f]/.test(email) || normalized.length > 254) return false;
  if (!/^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized)) {
    return false;
  }
  const local = normalized.slice(0, normalized.indexOf('@'));
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

export function validateInvite(
  email: string,
  displayName: string,
  currentEmail: string | null,
  role: 'admin' | 'super_admin' = 'admin',
) {
  const errors: { email?: string; displayName?: string; role?: string } = {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = displayName.trim();

  if (!isValidEmail(email)) {
    errors.email = '請輸入有效的電子郵件地址（最多 254 個字元）';
  } else if (currentEmail !== null && normalizedEmail === normalizeEmail(currentEmail)) {
    errors.email = '無法透過受邀帳號清單管理您自己的帳號';
  }
  if (normalizedName.length > 120) {
    errors.displayName = '顯示名稱不可超過 120 個字元';
  }
  if (role !== 'admin' && role !== 'super_admin') {
    errors.role = '請選擇管理員或超級管理員';
  }

  return {
    errors,
    data: { email: normalizedEmail, displayName: normalizedName, enabled: true as const, role },
  };
}

export function canManageAccount(
  actorRole: AccountRole | null,
  targetRole: AccountRole,
  targetEmail: string,
  currentEmail: string | null,
): boolean {
  if (currentEmail !== null && normalizeEmail(targetEmail) === normalizeEmail(currentEmail)) {
    return false;
  }
  if (actorRole === 'owner') return targetRole === 'admin' || targetRole === 'super_admin';
  return actorRole === 'super_admin' && targetRole === 'admin';
}

export function deriveAccess(input: AccessInput): {
  isAdmin: boolean;
  canManageAccounts: boolean;
  isOwner: boolean;
  role: AccountRole | null;
  invitationEmail: string | null;
} {
  const isOwner = input.roleClaim === 'owner'
    || (input.adminClaim === true && input.accountManagerClaim === true);
  const invitationEmail = input.emailVerified === true
    && input.signInProvider === 'google.com'
    && input.email !== null
    && isValidEmail(input.email)
    ? normalizeEmail(input.email)
    : null;
  const hasEnabledInvitation = invitationEmail !== null
    && input.invitation?.email === invitationEmail
    && input.invitation.enabled === true;
  const invitationRole = input.invitation?.role;
  const role: AccountRole | null = isOwner ? 'owner'
    : hasEnabledInvitation && (invitationRole === undefined || invitationRole === 'admin') ? 'admin'
      : hasEnabledInvitation && invitationRole === 'super_admin' ? 'super_admin'
        : null;

  return {
    isAdmin: role !== null,
    canManageAccounts: role === 'owner' || role === 'super_admin',
    isOwner,
    role,
    invitationEmail,
  };
}
