#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="chronological-correct"
STACK_NAME="CorrectStack"
export CDK_DISABLE_LEGACY_EXPORT_WARNING=1

SPINNER_PID=""

cleanup() {
  [[ -n "$SPINNER_PID" ]] && kill "$SPINNER_PID" 2>/dev/null || true
  echo ""
  echo "Tearing down containers..."
  docker ps -a --filter "name=$CONTAINER_NAME" --format "{{.Names}}" | xargs -r docker rm -f 2>/dev/null || true
}

trap cleanup EXIT

spin() {
  local msg="$1"
  local chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while true; do
    printf "\r       %s %s" "${chars:i%${#chars}:1}" "$msg"
    i=$((i + 1))
    sleep 0.1
  done
}

start_spinner() {
  spin "$1" &
  SPINNER_PID=$!
}

stop_spinner() {
  local msg="$1"
  [[ -n "$SPINNER_PID" ]] && kill "$SPINNER_PID" 2>/dev/null || true
  SPINNER_PID=""
  printf "\r       %s\n" "$msg"
}

cat <<'HEADER'

================================================================================
  THE SOLUTION: Stamp the arrival time BEFORE the event enters the queue
================================================================================

  This demo shows the fix: capture the arrival timestamp at the API boundary,
  so it survives any downstream retries or DLQ reprocessing.

  Architecture (correct approach):

    API Gateway  -->  Ingestion Lambda  -->  SQS Queue  -->  Processor Lambda
                      (stamps received_at                        |
                       from requestTimeEpoch)                    | on failure
                                                                 v
                                                               DLQ  -->  DLQ Processor Lambda

  The fix:
    - A dedicated Ingestion Lambda sits between API Gateway and SQS.
    - It reads "requestTimeEpoch" from the API Gateway context — this is the
      exact moment the HTTP request arrived — and embeds it as "received_at"
      in the message body.
    - Both the Processor and DLQ Processor read "received_at" from the message
      body. They NEVER set their own timestamp.
    - Result: even after DLQ reprocessing, "received_at" reflects the ORIGINAL
      arrival time, not the reprocessing time.

  What to watch for:
    - Same setup: 3 events, Event 1 fails on purpose and goes to the DLQ.
    - This time, when Event 1 is reprocessed from the DLQ, it KEEPS its
      original received_at timestamp from when it first arrived.
    - Sorting by received_at gives [1, 2, 3] — correct chronological order.

================================================================================

HEADER

echo "[1/4] Starting LocalStack (local AWS emulator)..."
start_spinner "Pulling image and starting container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 4566:4566 \
  -e SERVICES=sqs,lambda,apigateway,cloudformation,cloudwatch,logs,iam,s3,ssm,sts \
  -e LAMBDA_EXECUTOR=local \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -v /var/run/docker.sock:/var/run/docker.sock \
  localstack/localstack > /dev/null 2>&1
stop_spinner "Container started."

start_spinner "Waiting for services to be ready..."
until docker exec "$CONTAINER_NAME" curl -s http://localhost:4566/_localstack/health | grep -q '"available"' 2>/dev/null; do
  sleep 1
done
stop_spinner "Services ready."
echo ""

echo "[2/4] Deploying infrastructure (API Gateway, SQS queues, Lambda functions)..."
start_spinner "Bootstrapping CDK environment..."
npx cdklocal bootstrap aws://000000000000/us-east-1 --quiet 2>/dev/null > /dev/null
stop_spinner "CDK environment ready."

start_spinner "Creating SQS queues, Lambda functions, API Gateway..."
npx cdklocal deploy "$STACK_NAME" --require-approval never --quiet 2>/dev/null > /dev/null
stop_spinner "Stack deployed."
echo ""

echo "[3/4] Sending webhook events and waiting for processing..."
npx tsx scripts/simulate.ts "$STACK_NAME"
