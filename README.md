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
