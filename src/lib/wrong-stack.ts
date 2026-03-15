import type { Construct } from "constructs";

import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambdaBase from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class WrongStack extends Stack {
  private readonly DLQ_TIMEOUT = 30;
  private readonly QUEUE_TIMEOUT = 30;
  private readonly PROCESSOR_TIMEOUT = 10;
  private readonly DLQ_PROCESSOR_TIMEOUT = 10;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const dlq = this.createDLQ();
    const queue = this.createQueue(dlq);
    this.createProcessor(queue);
    this.createDLQProcessor(dlq);
    this.createApi(queue);
  }

  private createDLQ(): sqs.Queue {
    return new sqs.Queue(this, "DLQ", {
      queueName: "wrong-dlq",
      visibilityTimeout: Duration.seconds(this.DLQ_TIMEOUT),
    });
  }

  private createQueue(dlq: sqs.Queue): sqs.Queue {
    return new sqs.Queue(this, "Queue", {
      deadLetterQueue: {
        maxReceiveCount: 1,
        queue: dlq,
      },
      queueName: "wrong-queue",
      visibilityTimeout: Duration.seconds(this.QUEUE_TIMEOUT),
    });
  }

  private createProcessor(queue: sqs.Queue): void {
    const processorFn = new lambda.NodejsFunction(this, "ProcessorFn", {
      entry: "src/lambdas/wrong/processor.ts",
      functionName: "wrong-processor",
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
      entry: "src/lambdas/wrong/dlq-processor.ts",
      functionName: "wrong-dlq-processor",
      handler: "handler",
      runtime: lambdaBase.Runtime.NODEJS_24_X,
      timeout: Duration.seconds(this.DLQ_PROCESSOR_TIMEOUT),
    });

    dlqProcessorFn.addEventSource(
      new SqsEventSource(dlq, { batchSize: 1, reportBatchItemFailures: true }),
    );
  }

  private createApi(queue: sqs.Queue): void {
    const api = new apigateway.RestApi(this, "Api", {
      restApiName: "wrong-api",
    });

    const sqsIntegrationRole = new iam.Role(this, "ApiGatewaySqsRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    queue.grantSendMessages(sqsIntegrationRole);

    const sqsIntegration = new apigateway.AwsIntegration({
      integrationHttpMethod: "POST",
      options: {
        credentialsRole: sqsIntegrationRole,
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": '{"message": "queued"}',
            },
          },
        ],
        requestParameters: {
          "integration.request.header.Content-Type":
            "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          "application/json": "Action=SendMessage&MessageBody=$input.body",
        },
      },
      path: `${this.account}/${queue.queueName}`,
      service: "sqs",
    });

    const eventsResource = api.root.addResource("events");

    eventsResource.addMethod("POST", sqsIntegration, {
      methodResponses: [{ statusCode: "200" }],
    });

    new CfnOutput(this, "ApiUrl", {
      exportName: "WrongApiUrl",
      value: api.url,
    });
  }
}
