# Chronological

A demonstration of **chronological event ordering** with **Dead Letter Queue (DLQ) reprocessing** on AWS, built with CDK and testable locally via LocalStack.

## The Problem

In event-driven architectures, messages are often processed out of order. A consumer might receive event #3 before event #2 - due to retries, network variability, or parallel consumers pulling from the same queue. For many use cases this is acceptable, but some domains demand strict chronological ordering: financial transactions, audit logs, state machines, or any system where applying events out of sequence produces incorrect results.

The challenge compounds when a message fails processing. If event #2 fails and event #3 succeeds, the system is now in an inconsistent state. Simply retrying the failed message later doesn't help - by then, downstream state has already diverged.

## Case Study

This project explores a practical pattern for solving both problems together:

1. **Guaranteed ordering** - ensuring events for a given entity are processed in the exact sequence they were produced.
2. **DLQ reprocessing without ordering violations** - when a message fails and lands in a Dead Letter Queue, replaying it back into the pipeline without breaking the chronological guarantees for subsequent messages.

The architecture uses AWS services (SQS FIFO queues, Lambda, and DLQ) orchestrated via CDK, with a simulation script (`npm run simulate`) to demonstrate the behavior end-to-end.

### Key questions we investigate

- How do SQS FIFO queues and message group IDs enforce per-entity ordering?
- What happens when a message in the middle of a sequence fails - how does the FIFO queue behave?
- How can we design a DLQ reprocessing strategy that replays failed messages **in order** and blocks subsequent messages from the same group until the failure is resolved?
- What are the trade-offs between strict ordering and throughput?

## Stack Comparison

The project includes two CDK stacks that demonstrate the difference:

| Aspect                         | Wrong Stack                       | Correct Stack                                       |
| ------------------------------ | --------------------------------- | --------------------------------------------------- |
| API Gateway integration        | `AwsIntegration` (direct to SQS)  | `LambdaIntegration` (to ingestion Lambda)           |
| VTL mapping template           | Yes                               | No                                                  |
| IAM role for API Gateway → SQS | Manually created                  | Not needed                                          |
| Ingestion Lambda               | None                              | Yes — stamps `received_at`, sends to SQS            |
| SQS permissions                | Granted to API Gateway role       | Granted to ingestion Lambda via `grantSendMessages` |
| `@aws-sdk/client-sqs` usage    | No (API GW talks to SQS natively) | Yes (ingestion Lambda sends messages)               |

**Wrong Stack** — API Gateway sends the payload directly to SQS. The processing Lambdas set `received_at = Date.now()` at processing time. If an event fails and gets reprocessed from the DLQ later, its `received_at` reflects reprocessing time, breaking chronological order.

**Correct Stack** — API Gateway invokes an Ingestion Lambda first, which reads `requestContext.requestTimeEpoch` (the true arrival time) and embeds it as `received_at` in the message body before sending to SQS. Downstream Lambdas just read this pre-stamped value. Even after DLQ reprocessing, the original arrival time is preserved.

### VTL Mapping Templates

VTL (Velocity Template Language) mapping templates are used by API Gateway to transform request/response payloads between the client and the backend integration. In the wrong stack, the VTL template converts the incoming JSON body into the URL-encoded form that the SQS `SendMessage` API expects:

```
Action=SendMessage&MessageBody=$input.body
```

Since API Gateway calls SQS directly (no Lambda in between), it needs to speak SQS's native HTTP API format. The correct stack doesn't need VTL because it routes through a Lambda instead, which uses the AWS SDK to call SQS programmatically.

## Tech Stack

- **AWS CDK** (TypeScript) - infrastructure as code
- **LocalStack** via `aws-cdk-local` - local development and testing without an AWS account
- **SQS FIFO** - ordered message delivery
- **Lambda** - event consumers
- **DLQ** - failed message isolation and reprocessing

## Dependencies

- **[AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html)** (`aws-cdk`, `aws-cdk-lib`) - defines and deploys the infrastructure stacks
- **[aws-cdk-local](https://github.com/localstack/aws-cdk-local)** - wraps the CDK CLI to target LocalStack instead of AWS
- **[AWS Lambda Powertools for TypeScript](https://docs.aws.amazon.com/powertools/typescript/latest/)** - structured logging (`@aws-lambda-powertools/logger`) and SQS batch processing with partial failure reporting (`@aws-lambda-powertools/batch`)
- **[AWS SDK for JavaScript v3 - SQS](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/)** (`@aws-sdk/client-sqs`) - used by the ingestion Lambda to send timestamped messages to SQS
- **[tsx](https://github.com/privatenumber/tsx)** - runs TypeScript scripts directly without a build step

## Getting Started

The only prerequisite is **Docker**. Each script spins up a LocalStack container, deploys the CDK stack, runs the simulation, and prints the logs - all automatically.

```bash
# See what happens when ordering is NOT handled correctly
./run-wrong.sh

# See the correct approach with proper chronological guarantees
./run-correct.sh
```

Compare the logs from both runs to observe:

- **`run-wrong.sh`** - events processed out of order, inconsistent state after failures.
- **`run-correct.sh`** - strict ordering preserved, failed messages block their group until resolved.

## License

MIT
