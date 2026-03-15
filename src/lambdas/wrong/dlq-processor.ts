import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from "@aws-lambda-powertools/batch";
import type { SQSHandler, SQSRecord } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "wrong-dlq-processor" });
const processor = new BatchProcessor(EventType.SQS);

const recordHandler = async (record: SQSRecord): Promise<void> => {
  const body = JSON.parse(record.body);

  logger.info("Event processed from DLQ", {
    order: body.order,
    payload: body,
    received_at: Date.now(),
  });
};

export const handler: SQSHandler = async (event, context) =>
  processPartialResponse(event, recordHandler, processor, { context });
