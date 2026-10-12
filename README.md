# CK APP Announcement Admin

A standalone React, TypeScript, and Vite website that builds to `dist/` and deploys through GitHub Pages to [notification.cksc.tw](https://notification.cksc.tw/). Announcements are stored in the `announcements` Firestore collection shared with the app. Owners and super administrators can create administrator accounts from the Account Management page. This website is a separate project and does not add a sign-in flow for app users.

## Development and Validation

```sh
npm ci
npm test
npm run build
npm run dev
```

Run these commands from the root of the standalone `CKApp-Dev/Notification` repository. The mobile app lives in a separate repository.

By default, the website uses the public Firebase web configuration in `src/firebase-config.json` for the `ck-app-database` project. Analytics is not used. To switch Firebase projects, update that configuration or copy `.env.example` to `.env.local` and set the `VITE_FIREBASE_*` overrides. Environment variables are embedded at build time, so changes require rebuilding and redeploying the website. These settings are public browser configuration; never include service account private keys in the website.

## GitHub Pages Deployment

1. Place the website source at the root of `CKApp-Dev/Notification`, with `package.json`, `src/`, `index.html`, and `.github/workflows/pages.yml` at their expected paths. Exclude `node_modules/`, `dist/`, local environment files, and `.openai/`.
2. In the GitHub repository, go to Settings → Pages → Build and deployment and select **GitHub Actions**.
3. Push to `main` or manually run the **Deploy admin website to GitHub Pages** workflow. It installs dependencies, runs tests, builds the website, uploads `dist/`, and deploys to the `github-pages` environment.
4. Set the Pages custom domain to `notification.cksc.tw`. The workflow sets Vite's `ADMIN_BASE_PATH` using the `base_path` output from `actions/configure-pages`, supporting the custom domain at `/` and the default `/Notification/` subpath. For a manual custom-domain build, run `ADMIN_BASE_PATH=/ npm run build`. The local default is `/`.
5. Ensure Firebase's Authorized domains list includes `notification.cksc.tw`. Enter the hostname only, without a path.

The workflow uses the official `checkout@v7`, `setup-node@v7`, `configure-pages@v5`, `upload-pages-artifact@v4`, and `deploy-pages@v4` actions. See [custom GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [checkout releases](https://github.com/actions/checkout/releases), and [setup-node releases](https://github.com/actions/setup-node/releases). Building and deploying the website does not require a Firebase service account. Configure credentials for the scheduled publisher separately; never include them in public configuration or website build artifacts.

## Sign-In and Administrator Permissions

1. In Firebase Console → Authentication → Sign-in method, enable Google and set the project's support email address.
2. Under Authentication → Settings → Authorized domains, add `notification.cksc.tw`. Add the domains of any additional website mirrors as well. For local development, also add `localhost` and `127.0.0.1`; new projects may not authorize local domains automatically.
3. The first owner must sign in with Google to create a Firebase Authentication account. Accounts without authorization or an invitation will see an insufficient permissions screen.
4. Bootstrap the first owner from a trusted environment with `npm --prefix firebase run grant-admin -- --project ck-app-database --email owner@example.com --role owner`. The owner must first sign in with Google. This writes a protected owner registry record and server-issued owner claims. The website cannot create owners and does not authorize users by email domain.
5. Click **Recheck Permissions** or sign in again after bootstrapping. Owners and enabled super administrators see **Account Management**. The header shows the current role.
6. Owners and super administrators create accounts for the exact Google email address and choose `admin` or `super_admin`. Invitees need no custom claims; Firestore Rules enforce the account's live role and enabled status.

Before enabling super administrators on an existing deployment, run the updated bootstrap command for the current owner. It registers all existing owners with `role: owner` so they appear as protected accounts. Legacy owners with both strict boolean claims `admin: true` and `accountManager: true` retain owner access. An `admin: true` claim alone no longer grants access: create an enabled account record for each existing announcement administrator, or run the trusted helper with `--role admin` to migrate that user. Refresh permissions after deploying the rules and website together.

Google sign-in uses a popup by default. If the browser blocks it, the website prompts the user to allow popups and try again. Setting `VITE_FIREBASE_ENABLE_REDIRECT=true` enables a full-page sign-in fallback button, but **first configure a same-origin auth helper, reverse proxy, or appropriate Firebase Hosting setup according to Firebase's third-party storage restrictions guide**. A standard GitHub Pages static domain does not automatically provide the `/__/auth/*` helper, so redirect sign-in is disabled by default. See the documentation for [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [redirect configuration](https://firebase.google.com/docs/auth/web/redirect-best-practices), and [custom claims](https://firebase.google.com/docs/auth/admin/custom-claims).

## Account Management and Invitations

| Role | Announcements | Create admin / super_admin | Manage or delete admin | Manage or delete super_admin | Delete owner |
| --- | --- | --- | --- | --- | --- |
| `owner` | Yes | Yes | Yes | Yes | Never |
| `super_admin` | Yes | Yes | Yes | No | Never |
| `admin` | Yes | No | No | No | Never |

- Account management includes editing display names, disabling or restoring access, and deleting site account records after confirmation. No one can manage their own record in the website. Existing roles are immutable; only the trusted bootstrap helper can change them. Only an owner can disable, edit, or delete a super administrator, preventing peer removal through an intermediate role change.
- Creating an account grants eligibility to sign in. It does not send email or create a Firebase Authentication user in advance. Share the website link with the invitee; their authentication account is created when they first sign in with that Google account.
- Email addresses are trimmed and converted to lowercase, with a maximum length of 254 characters. Invalid formats, paths, control characters, and internal whitespace are rejected. Dots and `+` aliases are preserved, so enter the exact email address shown after sign-in.
- Display names are optional, limited to 120 characters, and affect only the account list.
- Regular administrators can manage announcements only. They cannot list accounts, create users, change permissions, or set passwords.
- Disabling or deleting any non-owner account revokes database administration access on subsequent server requests, including with an existing sign-in token. The website watches the user's own record and clears administration views when access is revoked. Previously downloaded data cannot be recalled. Deleting site access does not delete the Google account, Firebase Authentication identity, or existing announcements.
- Owner records are created only by the trusted bootstrap helper. Their roles and records cannot be changed, disabled, or deleted through the website, including by another owner. A record marked `owner` does not itself confer owner access; owner privileges require trusted claims.

Accounts are stored at `adminAccounts/{normalizedLowercaseEmail}`, with the document ID matching `email`:

```ts
{
  email: string,
  displayName: string,
  role: 'owner' | 'super_admin' | 'admin',
  enabled: boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: string // Firebase Auth UID of the creator
}
```

New accounts use server timestamps for `createdAt` and `updatedAt`. Website updates change only the display name or enabled status, along with `updatedAt`, preserving the email, role, creation time, and creator. Legacy invitations without a `role` remain regular administrators. Unknown roles fail closed.

The supplied `public/icon.png` is used as the website brand image, announcement preview image, favicon, Apple touch icon, and social page image. Local asset paths respect Vite's configured deployment base path.

## Announcement Workflow

- Titles are limited to 120 characters, plain-text content to 10,000 characters, and optional links to 2,048 characters. Links must use HTTPS.
- All date and time inputs are interpreted in `Asia/Taipei` (UTC+8), regardless of the administrator's browser time zone.
- **Save Draft** creates or updates a `draft` without publishing it automatically.
- **Save Publication Time (儲存待發布時間)** saves the announcement as `scheduled` with a future `publishAt`. It does not start the worker or arrange an automatic run; an administrator must process it after that time.
- **Publish Now (立即發布)** saves the announcement as `scheduled` with a server timestamp, waits for the save, and makes one authenticated request to the publication service. Draft saves and future-time saves never invoke it. If processing fails, the saved announcement remains available; use the processing button to retry rather than creating another announcement.
- **Process Pending Announcements and Notifications (處理待發布公告與通知)** explicitly starts one bounded pass for all due announcements, pending delivery and due receipts. A completed pass does not guarantee every notification was sent or displayed. Large recipient lists, delivery backoff and receipts (first checked after 15 minutes) can require later clicks.
- There are no periodic worker invocations. GitHub Actions retains **Run workflow** as an operator fallback, with no cron trigger. Future-dated announcements stay private until a manual pass runs after their due time.
- Only draft and scheduled announcements can be edited. Published announcements can only be archived. Archiving updates only `status` and `updatedAt`.
- The announcement list synchronizes the latest 200 records in real time, and its statistics cover those same 200 records. There is no demo or mock data.
- Before saving, the website checks `updatedAt` to avoid overwriting changes another administrator has already saved.

Firestore schema:

```ts
{
  title: string,
  body: string,
  url: string,
  status: 'draft' | 'scheduled' | 'published' | 'archived',
  publishAt: Timestamp,
  publishedAt: Timestamp | null,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: string // Firebase Auth UID
}
```

New announcements use server timestamps for `createdAt` and `updatedAt`, with `publishedAt` set to `null`. Firestore Rules, publication and server push delivery code are in `firebase/`. The mobile notification client lives in its separate app repository. Deploy the authenticated [Cloud Run service](firebase/cloud-run/README.md), set the public repository variable `VITE_ANNOUNCEMENTS_WORKER_URL` to its HTTPS `/run` endpoint, and rebuild the website. With no valid endpoint configured, the website permits saves but disables publication. No backend keys enter the browser. Cloud Run deployment requires an already enabled billing account; changing source or deploying the static website alone does not deploy it or disable any existing live Scheduler job.
