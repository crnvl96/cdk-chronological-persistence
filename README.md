# Chronological

A demonstration of **chronological event ordering** with **Dead Letter Queue (DLQ) reprocessing** on AWS, built with CDK and testable locally via LocalStack.

## The Problem

In event-driven architectures, messages are often processed out of order. A consumer might receive event #3 before event #2, due to retries, network variability, or parallel consumers pulling from the same queue. For many use cases this is acceptable, but some domains demand strict chronological ordering: financial transactions, audit logs, state machines, or any system where applying events out of sequence produces incorrect results.

The challenge arises when a message fails processing. If event #2 fails and event #3 succeeds, the system is now in an inconsistent state. Simply retrying the failed message later doesn't help - by then, downstream state has already diverged.

## Getting Started

### Prerequisites

- **Docker** - the only requirement. Everything else runs inside containers.

### Run with Docker

Build the image once from the project root:

> this pre-installs all dependencies, pre-synthesizes the CDK stacks, and caches the LocalStack image so subsequent runs start fast

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

### What to expect

Each script is self-contained - it starts a LocalStack container, deploys infrastructure, sends events, waits for processing, and prints results. Everything is cleaned up automatically on exit.

The scripts send 3 webhook events in order. Event 1 is designed to fail and go to the Dead Letter Queue. After reprocessing:

- **`WrongStack`** - events appear as `[2, 3, 1]` when sorted by `received_at`, because the timestamp was set at reprocessing time, not arrival time.
- **`CorrectStack`** - events appear as `[1, 2, 3]`, because the arrival timestamp was captured before the event entered the queue.

## Case Study

This project explores a practical pattern for solving both problems together:

1. **Guaranteed ordering**: ensuring events for a given entity are processed in the exact sequence they were produced.
2. **DLQ reprocessing without ordering violations**: when a message fails and lands in a Dead Letter Queue, replaying it back into the pipeline without breaking the chronological guarantees for subsequent messages.

The architecture uses AWS services (SQS queues, Lambda, and DLQ) orchestrated via CDK, with a simulation script to demonstrate the behavior end-to-end.

## Stack Comparison

The project includes two CDK stacks that demonstrate the difference:

| Aspect                         | Wrong Stack                      | Correct Stack                                       |
| ------------------------------ | -------------------------------- | --------------------------------------------------- |
| API Gateway integration        | `AwsIntegration` (direct to SQS) | `LambdaIntegration` (to ingestion Lambda)           |
| VTL mapping template           | Yes                              | No                                                  |
| IAM role for API Gateway → SQS | Manually created                 | Not needed                                          |
| Ingestion Lambda               | None                             | Yes, stamps `received_at`, sends to SQS             |
| SQS permissions                | Granted to API Gateway role      | Granted to ingestion Lambda via `grantSendMessages` |

**Wrong Stack** - API Gateway sends the payload directly to SQS. The processing Lambdas set `received_at = Date.now()` at processing time. If an event fails and gets reprocessed from the DLQ later, its `received_at` reflects reprocessing time, breaking chronological order.

```
Webhook --> API Gateway --> SQS Queue --> Processor Lambda --> CloudWatch Logs
            (VTL mapping)                  |
                                           | on failure
                                           |
                                           v
                                          DLQ --> DLQ Processor --> CloudWatch Logs

  Both Lambdas set: received_at = Date.now()
  A failed event reprocessed later gets a NEW timestamp, breaking chronological order.

  Result (sorted by received_at):

    Event #2  received_at = T+1s  (processed normally)
    Event #3  received_at = T+2s  (processed normally)
    Event #1  received_at = T+30s (reprocessed from DLQ, appears LAST)
```

**Correct Stack** - API Gateway invokes an Ingestion Lambda first, which reads `requestContext.requestTimeEpoch` (the true arrival time) and embeds it as `received_at` in the message body before sending to SQS. Downstream Lambdas just read this pre-stamped value. Even after DLQ reprocessing, the original arrival time is preserved.

```
Webhook --> API Gateway --> Ingestion Lambda --> SQS Queue --> Processor Lambda --> CloudWatch Logs
                             |                                  |
                             | stamps received_at               | on failure
                             | from requestTimeEpoch            v
                             |                                 DLQ --> DLQ Processor --> CloudWatch Logs
                             v
                  received_at is now part of
                  the message body both Lambdas
                  read it as-is

  Timestamp set ONCE at ingestion time, before the event enters the queue.
  DLQ reprocessing preserves the original arrival timestamp.

  Result (sorted by received_at):

    Event #1  received_at = T+0s (reprocessed from DLQ, still appears FIRST)
    Event #2  received_at = T+1s (processed normally)
    Event #3  received_at = T+2s (processed normally)
```

### VTL Mapping Templates

VTL (Velocity Template Language) mapping templates are used by API Gateway to transform request/response payloads between the client and the backend integration. In the wrong stack, the VTL template converts the incoming JSON body into the URL-encoded form that the SQS `SendMessage` API expects:

```
Action=SendMessage&MessageBody=$input.body
```

Since API Gateway calls SQS directly (no Lambda in between), it needs to speak SQS's native HTTP API format. The correct stack doesn't need VTL because it routes through a Lambda instead, which uses the AWS SDK to call SQS programmatically.

### Why Not FIFO Queues?

SQS FIFO queues guarantee message ordering within a message group, so they might seem like the natural choice here. This project uses standard queues instead, for two reasons.

**FIFO doesn't solve the DLQ reprocessing problem.** FIFO ordering guarantees apply within a single queue. When a message fails and lands in a DLQ those guarantees no longer hold. Replaying from the DLQ back into the main queue gives the message a new position. You still need the `received_at` timestamp stamped at ingestion time to reconstruct the original chronological order. The correct stack pattern works regardless of queue type.

**Throughput constraints under burst load.** FIFO queues cap the Lambda event source batch size at 10. In a real application receiving over 100,000 events per day, traffic often arrives in bursts rather than evenly spread. During peak spikes, the small batch size means significantly more Lambda invocations, higher concurrency requirements, and higher cost per message processed. Standard queues handle bursts more efficiently, and the application-level timestamp pattern gives you the ordering guarantees you actually need.

## Tech Stack

- **AWS CDK**: infrastructure as code
- **LocalStack** via `aws-cdk-local`: local development and testing without an AWS account
- **SQS**: message delivery
- **Lambda**: event consumers
- **DLQ**: failed message isolation and reprocessing

## License

MIT
