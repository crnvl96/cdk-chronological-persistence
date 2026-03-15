#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="chronological-wrong"
STACK_NAME="WrongStack"
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
  THE PROBLEM: Events lose chronological order after DLQ reprocessing
================================================================================

  This demo shows what happens when you DON'T capture the arrival timestamp
  at the moment a webhook hits your API.

  Architecture (wrong approach):

    API Gateway  -->  SQS Queue  -->  Processor Lambda (sets received_at = now())
                                          |
                                          | on failure
                                          v
                                        DLQ  -->  DLQ Processor Lambda (sets received_at = now())

  The problem:
    - The processor sets "received_at = Date.now()" when it processes a message.
    - If a message fails and goes to the Dead Letter Queue (DLQ), it gets
      reprocessed LATER — and "received_at" is set to that later time.
    - Result: the event that arrived FIRST now appears LAST when you sort
      by received_at.

  What to watch for:
    - We send 3 events in order: Event 1, Event 2, Event 3.
    - Event 1 is designed to FAIL on purpose, so it goes to the DLQ.
    - Events 2 and 3 process normally.
    - When Event 1 is reprocessed from the DLQ, it gets a NEW received_at
      timestamp — much later than Events 2 and 3.
    - Sorting by received_at gives [2, 3, 1] instead of [1, 2, 3].

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
