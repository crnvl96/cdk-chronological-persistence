import type { Construct } from "constructs";

import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambdaBase from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class CorrectStack extends Stack {
  private readonly DLQ_TIMEOUT = 30;
  private readonly QUEUE_TIMEOUT = 30;
  private readonly INGESTION_TIMEOUT = 10;
  private readonly PROCESSOR_TIMEOUT = 10;
  private readonly DLQ_PROCESSOR_TIMEOUT = 10;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const dlq = this.createDLQ();
    const queue = this.createQueue(dlq);
    const ingestionFn = this.createIngestion(queue);
    this.createProcessor(queue);
    this.createDLQProcessor(dlq);
    this.createApi(ingestionFn);
  }

  private createDLQ(): sqs.Queue {
    return new sqs.Queue(this, "DLQ", {
      queueName: "correct-dlq",
      visibilityTimeout: Duration.seconds(this.DLQ_TIMEOUT),
    });
  }

  private createQueue(dlq: sqs.Queue): sqs.Queue {
    return new sqs.Queue(this, "Queue", {
      deadLetterQueue: {
        maxReceiveCount: 1,
        queue: dlq,
      },
      queueName: "correct-queue",
      visibilityTimeout: Duration.seconds(this.QUEUE_TIMEOUT),
    });
  }

  private createIngestion(queue: sqs.Queue): lambda.NodejsFunction {
    const ingestionFn = new lambda.NodejsFunction(this, "IngestionFn", {
      entry: "lambdas/correct/ingestion.ts",
      environment: {
        QUEUE_URL: queue.queueUrl,
      },
      functionName: "correct-ingestion",
      handler: "handler",
      runtime: lambdaBase.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(this.INGESTION_TIMEOUT),
    });

    queue.grantSendMessages(ingestionFn);

    return ingestionFn;
  }

  private createProcessor(queue: sqs.Queue): void {
    const processorFn = new lambda.NodejsFunction(this, "ProcessorFn", {
      entry: "lambdas/correct/processor.ts",
      functionName: "correct-processor",
      handler: "handler",
      runtime: lambdaBase.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(this.PROCESSOR_TIMEOUT),
    });

    processorFn.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
  }

  private createDLQProcessor(dlq: sqs.Queue): void {
    const dlqProcessorFn = new lambda.NodejsFunction(this, "DlqProcessorFn", {
      entry: "lambdas/correct/dlq-processor.ts",
      functionName: "correct-dlq-processor",
      handler: "handler",
      runtime: lambdaBase.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(this.DLQ_PROCESSOR_TIMEOUT),
    });

    dlqProcessorFn.addEventSource(
      new SqsEventSource(dlq, { batchSize: 1, reportBatchItemFailures: true }),
    );
  }

  private createApi(ingestionFn: lambda.NodejsFunction): void {
    const api = new apigateway.RestApi(this, "Api", {
      restApiName: "correct-api",
    });

    const ingestionIntegration = new apigateway.LambdaIntegration(ingestionFn);

    const eventsResource = api.root.addResource("events");

    eventsResource.addMethod("POST", ingestionIntegration, {
      methodResponses: [{ statusCode: "200" }],
    });

    new CfnOutput(this, "ApiUrl", {
      exportName: "CorrectApiUrl",
      value: api.url,
    });
  }
}
