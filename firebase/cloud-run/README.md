# Publish only from administrator actions

The admin website calls `POST /run` once when an administrator presses **立即發布** or **處理待發布公告與通知**. The service runs the existing bounded worker and awaits that pass. It has no timer, startup execution, automatic retry or Scheduler job. Drafts and future publication-time saves do not call it. Future-dated announcements require a manual processing action after their due time.

## Authentication

Cloud Run accepts browser transport using `--no-invoker-iam-check`; the application rejects work without a valid Firebase ID token and server-side administrator authorization. Every POST verifies the token for `ck-app-database`, then checks trusted owner claims or the verified Google user's current enabled `adminAccounts` membership with role `admin` or `super_admin`. A standalone admin claim does not grant access. Disabling or deleting a membership denies subsequent worker requests even with an existing token. Owner claim changes take effect when the old token expires. See [Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and [Cloud Run transport access](https://docs.cloud.google.com/run/docs/authenticating/public).

CORS is pinned to `https://notification.cksc.tw`. Preflight requests never invoke work. No service-account key or operator token is sent to the browser. Provider/token error details are redacted. The runtime uses its existing service-account Firestore permissions. Optional `EXPO_ACCESS_TOKEN` remains server-side.

## Deployment

The target is pinned to project `ck-app-database`, number `253500838094`, service `ck-announcements`, region `us-central1`. The script checks project identity and refuses to deploy without an enabled billing account. It never links billing itself. Changes to source do not alter live resources.

Print the proposed commands without credentials or network:

```sh
sh firebase/cloud-run/deploy.sh
```

Apply only with authorized deployment and already enabled billing, using a short-lived operator OAuth token piped through stdin to `sh firebase/cloud-run/deploy.sh --apply`. Never put tokens in arguments or files. The script disables tracing/file logs, isolates temporary CLI settings, removes them on exit, builds the allowlisted worker files, and deploys a non-root container by immutable image digest. It never calls `/run` or starts a worker pass during deployment. It does not create a Scheduler service account, enable the Scheduler API or create a job.

The service uses request-based CPU billing, one CPU, 512 MiB, concurrency one, minimum zero instances, maximum one instance and a 240-second request timeout. Builds, storage, Firestore, requests and logs remain billable; there is no fixed five-minute processing loop. The build identity receives image-writer, source-viewer and log-writer access; the runtime retains its existing Firestore role. [Cloud Run pricing](https://cloud.google.com/run/pricing)

Set the public GitHub repository variable `VITE_ANNOUNCEMENTS_WORKER_URL` to the HTTPS `/run` URL printed by deployment, then rebuild the Pages site. For local website development the same public value may go in `.env.local`. The browser accepts only an HTTPS `*.run.app/run` endpoint and never follows redirects with its ID token. Without valid configuration, publication buttons stay disabled and saves remain available.

## Retire existing periodic triggers

Deploying new code cannot remove an already configured external trigger. Remove the old GitHub cron by updating the default branch to the manual-only workflow. If the previous Cloud Scheduler job exists, pause it separately before considering the rollout complete:

```sh
gcloud scheduler jobs pause ck-announcements --project=ck-app-database --location=us-central1
```

The deployment script intentionally does not touch live Scheduler jobs. Ensure no other automated invoker targets this service. No live deployment, billing change, notification send or schedule pause was performed during source preparation.

## Validation and remaining work

```sh
node --test firebase/cloud-run/*.test.cjs
sh -n firebase/cloud-run/deploy.sh
npm --prefix firebase test
npm test
npm run build
```

Use mocks/emulators for offline tests. A live check requires an explicitly chosen test announcement/device: page load and draft/future saves make no worker request; Publish makes exactly one authenticated POST; unauthorized/disabled accounts cannot start work. Confirm the published row separately from push acceptance/display. A worker pass can leave large jobs, backoff retries or receipts for a later button press; receipt checks begin 15 minutes after acceptance. Manual retries preserve existing outbox jobs and accepted-recipient checkpoints.
