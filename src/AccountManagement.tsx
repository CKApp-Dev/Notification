import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { collection, doc, onSnapshot, orderBy, query, runTransaction, serverTimestamp, Timestamp, type DocumentData } from 'firebase/firestore';
import { db, friendlyError } from './firebase';
import { canManageAccount, normalizeEmail, ROLE_LABELS, validateInvite, type AccountRole, type Invitation } from './accounts-domain';
import { formatDate } from './domain';
import { Icon } from './ui';

function decodeInvitation(id: string, data: DocumentData): Invitation | null {
  const role = data.role === undefined ? 'admin' : data.role;
  if (data.email !== id || normalizeEmail(id) !== id || typeof data.displayName !== 'string'
    || typeof data.enabled !== 'boolean' || typeof data.createdBy !== 'string'
    || (role !== 'owner' && role !== 'super_admin' && role !== 'admin')) return null;
  return {
    email: id, displayName: data.displayName, enabled: data.enabled, role, createdBy: data.createdBy,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
  };
}

export default function AccountManagement({ user, role }: { user: User; role: AccountRole }) {
  const [rows, setRows] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'super_admin'>('admin');
  const [formErrors, setFormErrors] = useState<{ email?: string; displayName?: string; role?: string }>({});
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [nameBaseline, setNameBaseline] = useState<number | null>(null);
  const [nameError, setNameError] = useState('');
  const emailInput = useRef<HTMLInputElement>(null);
  const currentEmail = normalizeEmail(user.email ?? '');
  const otherRows = rows.filter(row => row.email !== currentEmail);
  const visibleRows = otherRows.filter(row => filter === 'all' || row.enabled === (filter === 'enabled'));
  const busy = creating || pendingEmail !== null;
  const canCreateAccounts = role === 'owner' || role === 'super_admin';

  useEffect(() => {
    setLoading(true); setListError('');
    return onSnapshot(query(collection(db!, 'adminAccounts'), orderBy('createdAt', 'desc')), snapshot => {
      const invitations = snapshot.docs.map(item => decodeInvitation(item.id, item.data())).filter((item): item is Invitation => item !== null);
      setRows(invitations); setLoading(false);
      setListError(invitations.length === snapshot.docs.length ? '' : '部分帳戶資料格式不正確，請聯絡專案管理者檢查。');
    }, error => { setRows([]); setLoading(false); setListError(friendlyError(error)); });
  }, [retry]);

  async function invite() {
    if (!canCreateAccounts || busy || loading || listError) return;
    const result = validateInvite(email, displayName, user.email, newRole);
    setFormErrors(result.errors); setInviteError(''); setInviteSuccess('');
    if (Object.keys(result.errors).length) {
      document.getElementById(result.errors.email ? 'invite-email' : result.errors.displayName ? 'invite-name' : 'invite-role')?.focus();
      return;
    }
    setCreating(true);
    try {
      await runTransaction(db!, async transaction => {
        const ref = doc(db!, 'adminAccounts', result.data.email);
        const existing = await transaction.get(ref);
        if (existing.exists()) throw new Error('invitation-exists');
        transaction.set(ref, { ...result.data, createdBy: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      });
      setEmail(''); setDisplayName('');
      setInviteSuccess(`已新增 ${ROLE_LABELS[result.data.role]} ${result.data.email}。請提供網站連結，並請對方以同一個 Google 帳戶登入。`);
      emailInput.current?.focus();
    } catch (error) {
      setInviteError(error instanceof Error && error.message === 'invitation-exists' ? '這個電子郵件已在帳戶名單。若已停用，請由有權限的管理者重新啟用。' : friendlyError(error));
    } finally { setCreating(false); }
  }

  async function updateInvitation(row: Invitation, action: 'name' | 'toggle' | 'remove') {
    if (busy || !canManageAccount(role, row.role, row.email, user.email)) return;
    const nextName = editedName.trim();
    setNameError(''); setActionError(''); setActionSuccess('');
    if (action === 'name' && nextName.length > 120) { setNameError('顯示名稱不可超過 120 個字元。'); return; }
    if (action === 'toggle' && row.enabled && !window.confirm(`停用 ${row.email} 的網站帳戶嗎？這會撤銷此帳戶的網站權限。既有公告與 Google 帳戶不會被刪除。`)) return;
    if (action === 'remove' && !window.confirm(`刪除 ${row.email} 的網站帳戶嗎？這會移除帳戶記錄並撤銷網站權限。既有公告與 Google 帳戶不會被刪除。`)) return;
    setPendingEmail(row.email);
    try {
      await runTransaction(db!, async transaction => {
        const ref = doc(db!, 'adminAccounts', row.email);
        const current = await transaction.get(ref);
        if (!current.exists()) throw new Error('invitation-missing');
        const latestRow = decodeInvitation(current.id, current.data());
        if (!latestRow || !canManageAccount(role, latestRow.role, latestRow.email, user.email)) throw new Error('account-protected');
        const expectedVersion = action === 'name' ? nameBaseline : row.updatedAt?.getTime() ?? null;
        if ((latestRow.updatedAt?.getTime() ?? null) !== expectedVersion || latestRow.role !== row.role) throw new Error('invitation-changed');
        if (action === 'remove') transaction.delete(ref);
        else transaction.update(ref, {
          ...(action === 'name' ? { displayName: nextName } : { enabled: !latestRow.enabled }),
          updatedAt: serverTimestamp(),
        });
      });
      if (action === 'name' || action === 'remove') setEditingEmail(null);
      setActionSuccess(action === 'name' ? '顯示名稱已更新。' : action === 'remove' ? '網站帳戶已刪除，Google 帳戶與既有公告不受影響。' : row.enabled ? '網站帳戶已停用。' : '網站帳戶已重新啟用。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setActionError(message === 'invitation-missing' ? '這個網站帳戶已被刪除，請確認最新名單。'
        : message === 'invitation-changed' ? '這個帳戶剛剛已更新，請確認最新資料後再操作。'
        : message === 'account-protected' ? '您無法管理這個帳戶。擁有者帳戶受保護，超級管理員帳戶僅由擁有者管理。'
        : friendlyError(error));
    } finally { setPendingEmail(null); }
  }

  return <>
    <main className="workspace accounts-workspace">
      <div className="page-heading">
        <div><p className="eyebrow">TEAM ACCESS</p><h1>帳戶管理</h1><p className="muted">設定夥伴的管理角色，讓每個帳戶都有清楚的權限。</p></div>
        <span className="owner-only"><Icon name="shield" size={15} />{ROLE_LABELS[role]}</span>
      </div>
      <section className="owner-account" aria-label={`目前登入的 ${ROLE_LABELS[role]} 帳戶`}>
        <div className="owner-avatar"><Icon name="shield" size={24} /></div>
        <div>
          <div className="owner-title"><h2>{ROLE_LABELS[role]} 帳戶</h2><span>目前帳戶 · {role === 'owner' ? '受保護' : '不可自我管理'}</span></div>
          <p className="owner-email">{user.email}</p>
          <p className="owner-explanation">{role === 'owner'
            ? '您擁有所有管理權限。擁有者帳戶無法透過此網站編輯、停用或刪除。'
            : '您可新增管理員與超級管理員，並管理公告管理員。超級管理員帳戶僅由擁有者編輯、停用或刪除。'}</p>
        </div>
      </section>
      <div className="accounts-layout">
        <section className="panel accounts-list-panel" aria-labelledby="accounts-list-title">
          <div className="panel-heading">
            <div><h2 id="accounts-list-title">網站帳戶 <span className="count">{otherRows.length}</span></h2><p className="accounts-list-hint">已啟用 {otherRows.filter(row => row.enabled).length} 位 · 已停用 {otherRows.filter(row => !row.enabled).length} 位</p></div>
            <span className="live-dot">即時同步</span>
          </div>
          <div className="filters" role="group" aria-label="依帳戶狀態篩選">
            {(['all', 'enabled', 'disabled'] as const).map(value => <button key={value} className={filter === value ? 'filter active' : 'filter'} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部帳戶' : value === 'enabled' ? '已啟用' : '已停用'}</button>)}
          </div>
          {actionError && <p className="notice error account-action-notice" role="alert">{actionError}</p>}
          {actionSuccess && <p className="notice success account-action-notice" role="status"><Icon name="check" size={17} />{actionSuccess}</p>}
          <div className="account-list" aria-live="polite">
            {loading ? <div className="list-empty"><span className="spinner" /><p>正在載入帳戶名單…</p></div>
              : listError ? <div className="list-empty"><p className="notice error" role="alert">{listError}</p><button className="button secondary" onClick={() => setRetry(previous => previous + 1)}>重新載入</button></div>
                : visibleRows.length === 0 ? <div className="list-empty">
                  <div className="empty-icon"><Icon name="shield" size={28} /></div>
                  <h3>{filter === 'all' ? '一起把消息傳得更好' : filter === 'enabled' ? '目前沒有已啟用的帳戶' : '目前沒有已停用的帳戶'}</h3>
                  <p>{filter === 'all' ? '輸入 Google 電子郵件，新增第一位團隊夥伴。' : '符合這個狀態的帳戶會顯示在這裡。'}</p>
                  {filter === 'all' && <button className="text-button" onClick={() => emailInput.current?.focus()}>新增帳戶 <Icon name="arrow" size={16} /></button>}
                </div>
                  : visibleRows.map(row => {
                    const manageable = canManageAccount(role, row.role, row.email, user.email);
                    return <article className="account-row" key={row.email}>
                      <div className="account-row-heading">
                        <div className="member-avatar" aria-hidden="true">{(row.displayName || row.email).slice(0, 1).toUpperCase()}</div>
                        <div className="account-identity"><div className="account-name-line"><h3>{row.displayName || '未設定顯示名稱'}</h3><span className={`account-role-badge role-${row.role}`}>{ROLE_LABELS[row.role]}</span></div><p>{row.email}</p></div>
                        <span className={`status-badge ${row.enabled ? 'published' : 'draft'}`}><span />{row.enabled ? '已啟用' : '已停用'}</span>
                      </div>
                      {manageable && editingEmail === row.email && <form className="inline-name-form" onSubmit={event => { event.preventDefault(); void updateInvitation(row, 'name'); }}>
                        <label htmlFor="edit-display-name">顯示名稱 <span className="optional">選填</span></label>
                        <div className="inline-name-fields">
                          <input id="edit-display-name" value={editedName} maxLength={120} onChange={event => { setEditedName(event.target.value); setNameError(''); }} placeholder="例如：活動組小編" disabled={busy} aria-invalid={!!nameError} aria-describedby={nameError ? 'edit-name-error' : undefined} autoFocus />
                          <button className="button primary" type="submit" disabled={busy}>儲存</button><button className="button secondary" type="button" onClick={() => setEditingEmail(null)} disabled={busy}>取消</button>
                        </div>
                        {nameError && <p className="field-error" id="edit-name-error">{nameError}</p>}
                      </form>}
                      <div className="account-row-footer">
                        <span>新增於 {formatDate(row.createdAt)}</span>
                        {manageable ? <div className="account-row-actions">
                          <button className="text-button" onClick={() => { setEditingEmail(row.email); setEditedName(row.displayName); setNameBaseline(row.updatedAt?.getTime() ?? null); setNameError(''); }} disabled={busy}>編輯名稱</button>
                          <button className="text-button" onClick={() => void updateInvitation(row, 'toggle')} disabled={busy}>{pendingEmail === row.email ? '處理中…' : row.enabled ? '停用帳戶' : '重新啟用'}</button>
                          <button className="text-button danger-text" onClick={() => void updateInvitation(row, 'remove')} disabled={busy}>刪除帳戶</button>
                        </div> : <span className="account-protection"><Icon name="shield" size={13} />{row.role === 'owner' ? '擁有者帳戶受保護，無法刪除' : '僅擁有者可管理此帳戶'}</span>}
                      </div>
                    </article>;
                  })}
          </div>
          <div className="list-footer">帳戶角色於新增時設定；公告管理員只能管理公告，無法進入帳戶管理。</div>
        </section>
        <aside className="panel invite-panel" aria-labelledby="invite-title">
          <div className="panel-heading"><div><p className="eyebrow">ADD A TEAMMATE</p><h2 id="invite-title">新增帳戶</h2></div><span className="invite-plus"><Icon name="plus" size={20} /></span></div>
          <form className="invite-form" noValidate onSubmit={event => { event.preventDefault(); void invite(); }}>
            <div className="field">
              <label htmlFor="invite-email">Google 電子郵件 <span className="required">*</span></label>
              <input ref={emailInput} id="invite-email" type="email" autoComplete="off" maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setFormErrors(previous => ({ ...previous, email: undefined })); setInviteSuccess(''); }} placeholder="name@gmail.com" disabled={busy || !canCreateAccounts} aria-invalid={!!formErrors.email} aria-describedby={formErrors.email ? 'invite-email-error' : 'invite-email-help'} required />
              {formErrors.email ? <span id="invite-email-error" className="field-error">{formErrors.email}</span> : <span id="invite-email-help" className="field-hint">也可使用已連結 Google 帳戶的其他電子郵件。請輸入對方實際登入時使用的地址。</span>}
            </div>
            <div className="field">
              <label htmlFor="invite-name">顯示名稱 <span className="optional">選填</span></label>
              <input id="invite-name" value={displayName} maxLength={120} onChange={event => { setDisplayName(event.target.value); setFormErrors(previous => ({ ...previous, displayName: undefined })); }} placeholder="例如：活動組小編" disabled={busy || !canCreateAccounts} aria-invalid={!!formErrors.displayName} aria-describedby={formErrors.displayName ? 'invite-name-error' : undefined} />
              {formErrors.displayName && <span id="invite-name-error" className="field-error">{formErrors.displayName}</span>}
            </div>
            <div className="field invite-role-field">
              <label htmlFor="invite-role">帳戶角色 <span className="required">*</span></label>
              <select id="invite-role" className="account-role-select" value={newRole} onChange={event => { setNewRole(event.target.value === 'super_admin' ? 'super_admin' : 'admin'); setFormErrors(previous => ({ ...previous, role: undefined })); setInviteSuccess(''); }} disabled={busy || !canCreateAccounts} aria-invalid={!!formErrors.role} aria-describedby={formErrors.role ? 'invite-role-error' : 'invite-role-help'} required style={{ height: '40px' }}>
                <option value="admin">{ROLE_LABELS.admin}</option><option value="super_admin">{ROLE_LABELS.super_admin}</option>
              </select>
              {formErrors.role && <span id="invite-role-error" className="field-error">{formErrors.role}</span>}
            </div>
            <div className="invite-role" id="invite-role-help"><Icon name={newRole === 'super_admin' ? 'shield' : 'file'} size={18} /><div><strong>{ROLE_LABELS[newRole]}</strong><span>{newRole === 'super_admin' ? '可管理公告、新增兩種管理員帳戶，並編輯、停用及刪除公告管理員。此帳戶僅由擁有者管理。' : '只能建立、編輯、排程及封存公告，無法管理其他帳戶。'}</span></div></div>
            {inviteError && <p className="notice error" role="alert">{inviteError}</p>}
            {inviteSuccess && <p className="notice success" role="status">{inviteSuccess}</p>}
            <button type="submit" className="button primary full" disabled={!canCreateAccounts || busy || loading || !!listError}><Icon name="plus" size={17} />{creating ? '正在新增帳戶…' : '新增帳戶'}</button>
            <p className="invite-footnote">新增帳戶會開放網站登入資格，不會寄送電子郵件。請提供網站連結，讓對方使用指定的 Google 帳戶登入。刪除網站帳戶不會刪除對方的 Google 帳戶。</p>
          </form>
        </aside>
      </div>
    </main>
    <footer className="workspace-footer">CK APP · 帳戶管理<span>讓每一份信任，都有清楚的界線。</span></footer>
  </>;
}
