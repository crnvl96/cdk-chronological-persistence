# Chronological

A demonstration of **chronological event ordering** with **Dead Letter Queue (DLQ) reprocessing** on AWS, built with CDK and testable locally via LocalStack.

## The Problem

In event-driven architectures, messages are often processed out of order. A consumer might receive event #3 before event #2 - due to retries, network variability, or parallel consumers pulling from the same queue. For many use cases this is acceptable, but some domains demand strict chronological ordering: financial transactions, audit logs, state machines, or any system where applying events out of sequence produces incorrect results.

The challenge compounds when a message fails processing. If event #2 fails and event #3 succeeds, the system is now in an inconsistent state. Simply retrying the failed message later doesn't help - by then, downstream state has already diverged.

## Case Study

This project explores a practical pattern for solving both problems together:

1. **Guaranteed ordering** - ensuring events for a given entity are processed in the exact sequence they were produced.
2. **DLQ reprocessing without ordering violations** - when a message fails and lands in a Dead Letter Queue, replaying it back into the pipeline without breaking the chronological guarantees for subsequent messages.

The architecture uses AWS services (SQS queues, Lambda, and DLQ) orchestrated via CDK, with a simulation script (`npm run simulate`) to demonstrate the behavior end-to-end.

### Key questions we investigate

- How do SQS queues and message group IDs enforce per-entity ordering?
- What happens when a message in the middle of a sequence fails - how does the queue behave?
- How can we design a DLQ reprocessing strategy that replays failed messages **in order** and blocks subsequent messages from the same group until the failure is resolved?
- What are the trade-offs between strict ordering and throughput?

## Stack Comparison

The project includes two CDK stacks that demonstrate the difference:

| Aspect                         | Wrong Stack                       | Correct Stack                                       |
| ------------------------------ | --------------------------------- | --------------------------------------------------- |
| API Gateway integration        | `AwsIntegration` (direct to SQS)  | `LambdaIntegration` (to ingestion Lambda)           |
| VTL mapping template           | Yes                               | No                                                  |
| IAM role for API Gateway → SQS | Manually created                  | Not needed                                          |
| Ingestion Lambda               | None                              | Yes - stamps `received_at`, sends to SQS            |
| SQS permissions                | Granted to API Gateway role       | Granted to ingestion Lambda via `grantSendMessages` |
| `@aws-sdk/client-sqs` usage    | No (API GW talks to SQS natively) | Yes (ingestion Lambda sends messages)               |

**Wrong Stack** - API Gateway sends the payload directly to SQS. The processing Lambdas set `received_at = Date.now()` at processing time. If an event fails and gets reprocessed from the DLQ later, its `received_at` reflects reprocessing time, breaking chronological order.

**Correct Stack** - API Gateway invokes an Ingestion Lambda first, which reads `requestContext.requestTimeEpoch` (the true arrival time) and embeds it as `received_at` in the message body before sending to SQS. Downstream Lambdas just read this pre-stamped value. Even after DLQ reprocessing, the original arrival time is preserved.

### VTL Mapping Templates

VTL (Velocity Template Language) mapping templates are used by API Gateway to transform request/response payloads between the client and the backend integration. In the wrong stack, the VTL template converts the incoming JSON body into the URL-encoded form that the SQS `SendMessage` API expects:

```
Action=SendMessage&MessageBody=$input.body
```

Since API Gateway calls SQS directly (no Lambda in between), it needs to speak SQS's native HTTP API format. The correct stack doesn't need VTL because it routes through a Lambda instead, which uses the AWS SDK to call SQS programmatically.

## Tech Stack

- **AWS CDK** (TypeScript) - infrastructure as code
- **LocalStack** via `aws-cdk-local` - local development and testing without an AWS account
- **SQS** - message delivery
- **Lambda** - event consumers
- **DLQ** - failed message isolation and reprocessing

## Dependencies

- **[AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html)** (`aws-cdk`, `aws-cdk-lib`) - defines and deploys the infrastructure stacks
- **[aws-cdk-local](https://github.com/localstack/aws-cdk-local)** - wraps the CDK CLI to target LocalStack instead of AWS
- **[AWS Lambda Powertools for TypeScript](https://docs.aws.amazon.com/powertools/typescript/latest/)** - structured logging (`@aws-lambda-powertools/logger`) and SQS batch processing with partial failure reporting (`@aws-lambda-powertools/batch`)
- **[AWS SDK for JavaScript v3 - SQS](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/)** (`@aws-sdk/client-sqs`) - used by the ingestion Lambda to send timestamped messages to SQS
- **[tsx](https://github.com/privatenumber/tsx)** - runs TypeScript scripts directly without a build step

## Getting Started

### Prerequisites

- **Docker** - the only requirement. Everything else runs inside containers.

### Run with Docker

Build the image once - this pre-installs all dependencies, pre-synthesizes the CDK stacks, and caches the LocalStack image so subsequent runs start fast:

```bash
docker build -t chronological .
```

Then run either demo:

```bash
# See the problem: events end up out of order after DLQ reprocessing
docker run --rm --network=host -v /var/run/docker.sock:/var/run/docker.sock chronological WrongStack

# See the solution: events maintain correct chronological order
docker run --rm --network=host -v /var/run/docker.sock:/var/run/docker.sock chronological CorrectStack
```

> `--network=host` lets the container reach LocalStack on `localhost:4566`.
> `-v /var/run/docker.sock` lets it manage the LocalStack container.

### What to expect

Each script is self-contained - it starts a LocalStack container, deploys infrastructure, sends events, waits for processing, and prints results. Everything is cleaned up automatically on exit.

The scripts send 3 webhook events in order. Event 1 is designed to fail and go to the Dead Letter Queue. After reprocessing:

- **`WrongStack`** - events appear as `[2, 3, 1]` when sorted by `received_at`, because the timestamp was set at reprocessing time, not arrival time.
- **`CorrectStack`** - events appear as `[1, 2, 3]`, because the arrival timestamp was captured before the event entered the queue.

## License

MIT
