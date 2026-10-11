# Prepared Cloud Scheduler replacement

This alternative runs the existing `firebase/worker` through an authenticated Cloud Run service every five minutes. It is prepared for review only; no cloud resources or billing settings have been changed. Applying the deployment script enables the required APIs and creates resources. It never links billing or changes the existing GitHub schedule.

The adapter accepts only `POST /run`, awaits the bounded worker pass, and returns HTTP 500 on failure so Scheduler can retry. Provider exceptions are not logged by the adapter. Cloud Run IAM authenticates callers before requests reach Node; no custom JWT code or service-account keys are needed. The server preserves the worker's optional `EXPO_ACCESS_TOKEN` setting. That secret is absent and unnecessary in the currently verified deployment.

## Target and prerequisites

All commands are pinned to project `ck-app-database`, number `253500838094`, service `ck-announcements`, region `us-central1`. Firestore is in US multi-region `nam5`, so `us-central1` is a nearby compute region. The script checks the project number before making changes.

**Billing approval is required before apply.** The project currently has billing disabled. Linking a billing account automatically upgrades its Firebase plan from Spark to Blaze. The script refuses deployment while billing is disabled and never links billing itself. [Firebase billing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)

The operator needs API enablement, Cloud Run/Scheduler/Build/Artifact Registry and storage resource administration, IAM policy updates, and permission to act as the attached service accounts. Project Owner plus Service Account User on the attached identities covers project setup; linking billing separately requires billing-account permission. Existing Google-managed service-agent roles must remain intact. [Cloud Run deployment permissions](https://docs.cloud.google.com/run/docs/deploying-source-code), [Scheduler authentication](https://docs.cloud.google.com/scheduler/docs/http-target-auth)

## Review and deployment

From the repository root, print the proposed commands without gcloud, credentials or network:

```sh
sh firebase/cloud-run/deploy.sh
```

Only after billing and deployment approval, apply with a current gcloud CLI and one short-lived operator OAuth token piped through stdin to `sh firebase/cloud-run/deploy.sh --apply`. Use the existing private token retrieval flow; never paste the token into command arguments or commit it. [gcloud supports access-token environment authentication](https://docs.cloud.google.com/sdk/docs/authenticate).

Apply disables shell tracing and file logs, isolates gcloud settings in a temporary directory, and removes that directory on exit. The token stays in process memory/environment and is not written to a credential/config file. It also works when stdin ends without a newline. The script does not log the token. Apply can leave created cloud resources in place if a later command fails; inspect them before retrying. It refuses to overwrite an existing Scheduler job.

The new identities separate access:

| Identity | Granted access |
| --- | --- |
| Existing `ck-announcements` | Existing Firestore data role; no new runtime privileges |
| `ck-announcements-scheduler` | Cloud Run Invoker on this service only |
| `ck-announcements-build` | Artifact Registry Writer on this image repository; Object Viewer on this source bucket; Logs Writer on this project |

Cloud Build uses the repository root as context, with the allowlist in `.gcloudignore`. Docker uses `Dockerfile.dockerignore` for the same bounded source selection. Neither uploads frontend files, `.git`, local dependencies, environment files, or credentials. Review an upload list with `gcloud meta list-files-for-upload --ignore-file=firebase/cloud-run/.gcloudignore` from the repository root before apply. The existing worker source is used directly without a copied implementation. The multi-stage Node 22 image runs as a non-root user and is deployed by immutable image digest.

The service uses request-based billing, one CPU, 512 MiB memory, concurrency one, zero minimum instances, maximum one instance and a 240-second request timeout. Scheduler sends OIDC with the service base URL as its audience and `/run` as its target path. Existing Firestore transactions, leases and checkpoints protect against repeated or overlapping delivery. [Scheduler delivery behavior](https://docs.cloud.google.com/scheduler/docs/overview)

## Cost and validation

One Scheduler job is free within the first three jobs per billing account, then US$0.10/month. At 8,640 invocations per 30 days, short worker passes may fit unused Cloud Run compute/request allowances. This is an estimate, not a zero-cost guarantee; Firestore, network, builds, logs and image/source storage can add charges. [Scheduler pricing](https://cloud.google.com/scheduler/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing)

Offline checks:

```sh
node --test firebase/cloud-run/*.test.cjs
sh -n firebase/cloud-run/deploy.sh
npm --prefix firebase test
```

Adapter tests cover completion timing, method/path restrictions and failure redaction. Mocked deployment tests verify project/billing rejection before mutation, stdin EOF handling, token redaction and temporary-state cleanup. Source allowlists were checked against required files and excluded environment, credential, dependency and frontend paths using Git ignore semantics.

No container build was performed because the local Docker daemon is unavailable. No live Cloud Run, Cloud Scheduler or billing changes were performed. After approved deployment, inspect the manually requested Scheduler execution, HTTP 200 and worker log; then observe two actual scheduled executions and verify a due announcement. Retire GitHub cron only after those checks pass. Scheduler improves delivery/retries but does not guarantee an exact publication timestamp.
