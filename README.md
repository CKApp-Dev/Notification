# CK APP Announcement Admin

A standalone React, TypeScript, and Vite website that builds to `dist/` and deploys to [GitHub Pages](https://ChrisSun0731.github.io/CK-App-Admin/). Announcements are stored in the `announcements` Firestore collection shared with the app. Owners can invite announcement administrators from the Account Management page. This website is a separate project and does not add a sign-in flow for app users.

## Development and Validation

```sh
npm ci
npm test
npm run build
npm run dev
```

Run these commands from the root of the standalone `ChrisSun0731/CK-App-Admin` repository. If you are working from the app repository, enter `admin/` first.

By default, the website uses the public Firebase web configuration in `src/firebase-config.json` for the `ck-app-database` project. Analytics is not used. To switch Firebase projects, update that configuration or copy `.env.example` to `.env.local` and set the `VITE_FIREBASE_*` overrides. Environment variables are embedded at build time, so changes require rebuilding and redeploying the website. These settings are public browser configuration; never include service account private keys in the website.

## GitHub Pages Deployment

1. Place the website source at the root of `ChrisSun0731/CK-App-Admin`, with `package.json`, `src/`, `index.html`, and `.github/workflows/pages.yml` at their expected paths. Exclude `node_modules/`, `dist/`, local environment files, and `.openai/`.
2. In the GitHub repository, go to Settings → Pages → Build and deployment and select **GitHub Actions**.
3. Push to `main` or manually run the **Deploy admin website to GitHub Pages** workflow. It installs dependencies, runs tests, builds the website, uploads `dist/`, and deploys to the `github-pages` environment.
4. The workflow sets Vite's `ADMIN_BASE_PATH` using the `base_path` output from `actions/configure-pages`, supporting both the `/CK-App-Admin/` subpath and custom domains. For a manual build, run `ADMIN_BASE_PATH=/CK-App-Admin/ npm run build`. The local default is `/`.
5. Ensure Firebase's Authorized domains list includes `chrissun0731.github.io`. Enter the hostname only, without a path.

The workflow uses the official `checkout@v7`, `setup-node@v7`, `configure-pages@v5`, `upload-pages-artifact@v4`, and `deploy-pages@v4` actions. See [custom GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [checkout releases](https://github.com/actions/checkout/releases), and [setup-node releases](https://github.com/actions/setup-node/releases). Building and deploying the website does not require a Firebase service account. Configure credentials for the scheduled publisher separately; never include them in public configuration or website build artifacts.

## Sign-In and Administrator Permissions

1. In Firebase Console → Authentication → Sign-in method, enable Google and set the project's support email address.
2. Under Authentication → Settings → Authorized domains, add `chrissun0731.github.io`. Add the domains of any additional website mirrors as well. For local development, also add `localhost` and `127.0.0.1`; new projects may not authorize local domains automatically.
3. The first owner must sign in with Google to create a Firebase Authentication account. Accounts without authorization or an invitation will see an insufficient permissions screen.
4. A project administrator must use the Firebase Admin SDK from a trusted server to set both custom claims, `admin: true` and `accountManager: true`, for the owner's UID. The backend project provides an authorization script. The website cannot grant these roles itself and does not authorize users based on their email domain.
5. After granting the owner role, click **Recheck Permissions** on the insufficient permissions screen or sign in again. A permissions refresh button is also available at the top right when signed in. Once permissions refresh, the **Account Management** tab appears. Both `admin` and `accountManager` must be the boolean value `true` to manage invitations.
6. Owners invite regular announcement administrators by entering their Google email address in **Account Management**. No additional custom claims are required. The website listens for changes to the verified Google account's own invitation record; backend Firestore Rules enforce the actual read and write permissions.

Google sign-in uses a popup by default. If the browser blocks it, the website prompts the user to allow popups and try again. Setting `VITE_FIREBASE_ENABLE_REDIRECT=true` enables a full-page sign-in fallback button, but **first configure a same-origin auth helper, reverse proxy, or appropriate Firebase Hosting setup according to Firebase's third-party storage restrictions guide**. A standard GitHub Pages static domain does not automatically provide the `/__/auth/*` helper, so redirect sign-in is disabled by default. See the documentation for [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin), [redirect configuration](https://firebase.google.com/docs/auth/web/redirect-best-practices), and [custom claims](https://firebase.google.com/docs/auth/admin/custom-claims).

## Account Management and Invitations

- In **Account Management**, owners can create invitations, filter enabled or disabled invitations, edit display names, disable or restore access, and remove invitations after confirmation.
- An invitation grants eligibility to sign in. It does not send an email or create a Firebase Authentication user in advance. Share the website link with the invitee directly; their authentication account is created when they first sign in with that Google account.
- Email addresses are trimmed and converted to lowercase, with a maximum length of 254 characters. Paths, control characters, internal whitespace, and invalid formats are rejected. Dots and `+` aliases in Google email addresses are not merged, so enter the exact email address shown after sign-in.
- Display names are optional and limited to 120 characters. They appear only in the invitation list and do not change the invitee's Google profile.
- Regular invited administrators can manage announcements only. They cannot read other invitations, invite users, change their own permissions, or set passwords.
- For administrators authorized solely through an invitation, disabling or removing that invitation immediately revokes database administration access. When the website receives the change to the user's own invitation, it clears the announcement editor and administration views. Removing an invitation does not delete the Google account, Firebase Authentication user, or existing announcements.
- The current owner appears in a protected card, is not listed as a regular invited administrator, and cannot invite themselves. The owner's existing project roles are independent of the invitation list, so disabling or removing an invitation does not revoke those roles. Owner role changes must be handled in a trusted Firebase Admin environment.

Invitations are stored at `adminAccounts/{normalizedLowercaseEmail}`, with the document ID matching `email`:

```ts
{
  email: string,
  displayName: string,
  enabled: boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: string // Firebase Auth UID of the owner who created the invitation
}
```

New invitations use server timestamps for `createdAt` and `updatedAt`. Updates change only the display name or enabled status, along with `updatedAt`, preserving the original email address, creation time, and creator.

## Announcement Workflow

- Titles are limited to 120 characters, plain-text content to 10,000 characters, and optional links to 2,048 characters. Links must use HTTPS.
- All date and time inputs are interpreted in `Asia/Taipei` (UTC+8), regardless of the administrator's browser time zone.
- **Save Draft** creates or updates a `draft` without publishing it automatically.
- **Schedule Publication** saves the announcement as `scheduled` with a future `publishAt`.
- **Publish Now** also saves the announcement as `scheduled`, with `publishAt` set to the current time. The website does not set `published` directly; a trusted scheduled backend handles publication and push notifications.
- The backend uses a GitHub Actions schedule to check for due announcements approximately every five minutes, set their status to `published`, and record `publishedAt`. The app retrieves published announcements and receives device notifications, subject to device permissions, connectivity, and system delivery. GitHub schedules may be delayed or skipped, so publication times are not guaranteed. **Publish Now** also waits for the next scheduled run. See [GitHub scheduled event limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- In public repositories, GitHub automatically disables scheduled workflows after 60 days without repository activity. Project administrators should regularly check Actions run history and re-enable disabled workflows from Actions. See [automatic schedule disabling conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
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

New announcements use server timestamps for `createdAt` and `updatedAt`, with `publishedAt` set to `null`. Firestore Rules, scheduled publishing, and device push notification code are in `firebase/`, at the repository root in both the app repository and this standalone website repository. Deploy the Firestore Rules and configure trusted credentials for the scheduled workflow separately. Deploying the static website alone does not enable scheduled publishing. This setup does not use Cloud Functions.
