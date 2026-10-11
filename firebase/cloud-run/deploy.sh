#!/bin/sh
set +x
set -eu

# Reviewable preparation only unless explicitly invoked with --apply.
if [ "${1:-}" != '--apply' ]; then
  printf '%s\n' 'Preparation only. Review firebase/cloud-run/README.md and the commands below. Billing must already be approved and enabled before apply.'
  sed -n '/^# DEPLOYMENT COMMANDS/,$p' "$0"
  exit 0
fi

command -v gcloud >/dev/null
if [ -t 0 ]; then
  printf '%s\n' 'Pipe a short-lived authorized operator OAuth access token through stdin.' >&2
  exit 1
fi
IFS= read -r CLOUDSDK_AUTH_ACCESS_TOKEN || test -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}"
test -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}"
export CLOUDSDK_AUTH_ACCESS_TOKEN

# Isolate CLI defaults and remove all temporary state, including on failure.
# Authentication comes only from the in-memory access token, never credential files.
TASK_GCLOUD_CONFIG=$(mktemp -d "${TMPDIR:-/tmp}/ck-announcements-gcloud.XXXXXX")
cleanup() {
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
  rm -rf -- "$TASK_GCLOUD_CONFIG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
export CLOUDSDK_CONFIG="$TASK_GCLOUD_CONFIG"
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export CLOUDSDK_CORE_PROJECT=ck-app-database

TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$TASK_DIR/../.." && pwd)
if [ "$(gcloud projects describe ck-app-database --format='value(projectNumber)')" != '253500838094' ]; then
  printf '%s\n' 'Project identity mismatch; refusing changes.' >&2
  exit 1
fi
case "$(gcloud billing projects describe ck-app-database --format='value(billingEnabled)')" in
  True|true) ;;
  *) printf '%s\n' 'Billing is disabled. Obtain approval and link billing before deployment.' >&2; exit 1 ;;
esac

# DEPLOYMENT COMMANDS
# These commands never link a billing account or upgrade Firebase themselves.
PROJECT='ck-app-database'
REGION='us-central1'
WORKER_SA='ck-announcements@ck-app-database.iam.gserviceaccount.com'
SCHEDULER_SA='ck-announcements-scheduler@ck-app-database.iam.gserviceaccount.com'
BUILD_SA='ck-announcements-build@ck-app-database.iam.gserviceaccount.com'
SOURCE_BUCKET='gs://ck-app-database-announcement-build-source'
IMAGE='us-central1-docker.pkg.dev/ck-app-database/ck-announcements/worker'
WORKER_TAG='candidate'

gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project="$PROJECT"

gcloud artifacts repositories describe ck-announcements --project="$PROJECT" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create ck-announcements --project="$PROJECT" --location="$REGION" --repository-format=docker

gcloud iam service-accounts describe "$BUILD_SA" --project="$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create ck-announcements-build --project="$PROJECT" --display-name='Announcement image builder'
gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create ck-announcements-scheduler --project="$PROJECT" --display-name='Announcement schedule invoker'
gcloud iam service-accounts describe "$WORKER_SA" --project="$PROJECT" >/dev/null

gcloud artifacts repositories add-iam-policy-binding ck-announcements --project="$PROJECT" --location="$REGION" --member="serviceAccount:$BUILD_SA" --role=roles/artifactregistry.writer >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD_SA" --role=roles/logging.logWriter >/dev/null

gcloud storage buckets describe "$SOURCE_BUCKET" --project="$PROJECT" >/dev/null 2>&1 ||
  gcloud storage buckets create "$SOURCE_BUCKET" --project="$PROJECT" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "$SOURCE_BUCKET" --member="serviceAccount:$BUILD_SA" --role=roles/storage.objectViewer >/dev/null

gcloud builds submit "$REPO_ROOT" --project="$PROJECT" --region="$REGION" --config="$TASK_DIR/cloudbuild.yaml" --ignore-file="$TASK_DIR/.gcloudignore" --service-account="projects/$PROJECT/serviceAccounts/$BUILD_SA" --gcs-source-staging-dir="$SOURCE_BUCKET/source" --substitutions="_WORKER_TAG=$WORKER_TAG"
DIGEST=$(gcloud artifacts docker images describe "$IMAGE:$WORKER_TAG" --project="$PROJECT" --format='value(image_summary.digest)')
case "$DIGEST" in sha256:*) ;; *) printf '%s\n' 'Image digest missing; refusing deployment.' >&2; exit 1 ;; esac

gcloud run deploy ck-announcements --project="$PROJECT" --region="$REGION" --image="$IMAGE@$DIGEST" --service-account="$WORKER_SA" --set-env-vars=GOOGLE_CLOUD_PROJECT=ck-app-database --cpu=1 --memory=512Mi --concurrency=1 --max-instances=1 --min-instances=0 --timeout=240s --cpu-throttling --no-cpu-boost --no-allow-unauthenticated --invoker-iam-check
gcloud run services add-iam-policy-binding ck-announcements --project="$PROJECT" --region="$REGION" --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker >/dev/null
SERVICE_URL=$(gcloud run services describe ck-announcements --project="$PROJECT" --region="$REGION" --format='value(status.url)')
case "$SERVICE_URL" in https://*.run.app) ;; *) printf '%s\n' 'Unexpected service URL; refusing schedule creation.' >&2; exit 1 ;; esac

# Do not overwrite an existing scheduler job without reviewing its identity/configuration.
gcloud scheduler jobs create http ck-announcements --project="$PROJECT" --location="$REGION" --schedule='*/5 * * * *' --time-zone=Asia/Taipei --uri="$SERVICE_URL/run" --http-method=post --message-body='{}' --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$SERVICE_URL" --attempt-deadline=240s --max-retry-attempts=3 --max-retry-duration=240s --min-backoff=10s --max-backoff=60s --max-doublings=2

# This verifies the scheduler's authentication path. Scheduled verification still follows.
gcloud scheduler jobs run ck-announcements --project="$PROJECT" --location="$REGION"
printf '%s\n' 'Inspect Cloud Run request/worker logs and two actual five-minute scheduled invocations before disabling GitHub cron.'
