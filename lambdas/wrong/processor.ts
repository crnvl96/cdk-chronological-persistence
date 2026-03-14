import {
  BatchProcessor,
  EventType,
  processPartialResponse
} from '@aws-lambda-powertools/batch'
import type { SQSHandler, SQSRecord } from 'aws-lambda'
import { Logger } from '@aws-lambda-powertools/logger'

const logger = new Logger({ serviceName: 'wrong-processor' })
const processor = new BatchProcessor(EventType.SQS)

const recordHandler = async (record: SQSRecord): Promise<void> => {
  const body = JSON.parse(record.body)

  if (body.simulateFailure) {
    logger.error('Simulated failure', { order: body.order })
    throw new Error(`Simulated failure for event order=${body.order}`)
  }

  logger.info('Event processed', {
    order: body.order,
    payload: body,
    received_at: Date.now()
  })
}

export const handler: SQSHandler = async (event, context) =>
  processPartialResponse(event, recordHandler, processor, { context })
