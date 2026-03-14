import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import type { APIGatewayProxyHandler } from 'aws-lambda'
import { Logger } from '@aws-lambda-powertools/logger'

const logger = new Logger({ serviceName: 'correct-ingestion' })
const sqs = new SQSClient()

const QUEUE_URL = process.env.QUEUE_URL!

export const handler: APIGatewayProxyHandler = async (event) => {
  const receivedAt = event.requestContext.requestTimeEpoch
  const body = JSON.parse(event.body ?? '{}')

  const enrichedMessage = {
    ...body,
    received_at: receivedAt
  }

  logger.info('Ingesting event', {
    order: body.order,
    received_at: receivedAt
  })

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(enrichedMessage)
    })
  )

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Event ingested', received_at: receivedAt })
  }
}
