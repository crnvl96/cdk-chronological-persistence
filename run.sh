#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${1:?Usage: ./run.sh <WrongStack|CorrectStack>}"
CONTAINER_NAME="chronological-$(echo "$STACK_NAME" | sed 's/Stack$//' | tr '[:upper:]' '[:lower:]')"
export CDK_DISABLE_LEGACY_EXPORT_WARNING=1

cleanup() {
  echo ""
  echo "Tearing down containers..."
  docker rm -f $(docker ps -aq --filter "name=$CONTAINER_NAME") 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/4] Starting LocalStack (local AWS emulator)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 4566:4566 \
  -e SERVICES=sqs,lambda,apigateway,cloudformation,cloudwatch,logs,iam,s3,ssm,sts \
  -e LAMBDA_EXECUTOR=local \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -v /var/run/docker.sock:/var/run/docker.sock \
  localstack/localstack > /dev/null 2>&1

until docker exec "$CONTAINER_NAME" curl -s http://localhost:4566/_localstack/health | grep -q '"available"' 2>/dev/null; do
  sleep 1
done
echo "       LocalStack ready."

echo ""
echo "[2/4] Deploying infrastructure..."
npx cdklocal bootstrap aws://000000000000/us-east-1 --quiet 2>/dev/null > /dev/null
npx cdklocal deploy "$STACK_NAME" --require-approval never --quiet 2>/dev/null > /dev/null
echo "       Stack deployed."

echo ""
echo "[3/4] Sending webhook events and waiting for processing..."
npx tsx scripts/simulate/main.ts "$STACK_NAME"
