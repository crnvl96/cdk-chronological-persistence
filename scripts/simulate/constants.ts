export const LOCALSTACK_ENDPOINT = "http://localhost:4566";

export const STACKS = {
  CorrectStack: {
    exportName: "CorrectApiUrl",
    logGroups: [
      "/aws/lambda/correct-processor",
      "/aws/lambda/correct-dlq-processor",
    ],
  },
  WrongStack: {
    exportName: "WrongApiUrl",
    logGroups: [
      "/aws/lambda/wrong-processor",
      "/aws/lambda/wrong-dlq-processor",
    ],
  },
} as const;

export const EVENTS = [
  { order: 1, simulateFailure: true },
  { order: 2 },
  { order: 3 },
];

export const SEND_DELAY_MS = 1_000;

export const DLQ_WAIT_MS = 20_000;

export const PROCESSING_WAIT_MS = 5_000;
