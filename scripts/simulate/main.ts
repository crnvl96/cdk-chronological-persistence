const LOCALSTACK_ENDPOINT = "http://localhost:4566";

const STACKS = {
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

type StackName = keyof typeof STACKS;

const EVENTS = [
  { order: 1, simulateFailure: true },
  { order: 2 },
  { order: 3 },
];

const SEND_DELAY_MS = 1_000;
const DLQ_WAIT_MS = 20_000;
const PROCESSING_WAIT_MS = 5_000;

async function getApiUrl(stackName: StackName): Promise<string> {
  const config = STACKS[stackName];
  const response = await fetch(
    `${LOCALSTACK_ENDPOINT}/?Action=DescribeStacks&StackName=${stackName}`,
  );
  const xml = await response.text();

  const exportPattern = new RegExp(
    `<ExportName>${config.exportName}</ExportName>`,
  );
  const match = exportPattern.exec(xml);

  if (!match) {
    throw new Error(
      `Export "${config.exportName}" not found in DescribeStacks response`,
    );
  }

  const outputBlock = xml.substring(
    Math.max(0, match.index - 300),
    match.index + match[0].length,
  );
  const valueMatch = /<OutputValue>([^<]+)<\/OutputValue>/.exec(outputBlock);

  if (!valueMatch) {
    throw new Error("Could not parse OutputValue from DescribeStacks response");
  }

  return valueMatch[1]!;
}

async function sendEvents(apiUrl: string): Promise<void> {
  const eventsUrl = `${apiUrl}events`;

  for (const event of EVENTS) {
    const failNote =
      "simulateFailure" in event
        ? " (will FAIL on purpose -> goes to DLQ)"
        : "";
    console.log(`       Event ${event.order}: sending...${failNote}`);

    const response = await fetch(eventsUrl, {
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to send event order=${event.order}: ${response.status} ${text}`,
      );
    }

    if (event !== EVENTS[EVENTS.length - 1]) {
      await sleep(SEND_DELAY_MS);
    }
  }
}

interface LogEvent {
  message: string;
  order: number;
  received_at: number;
  source: string;
}

async function logsRequest(
  target: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${LOCALSTACK_ENDPOINT}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `Logs_20140328.${target}`,
    },
    method: "POST",
  });

  return response.json();
}

async function fetchLogs(stackName: StackName): Promise<LogEvent[]> {
  const config = STACKS[stackName];
  const events: LogEvent[] = [];

  for (const logGroup of config.logGroups) {
    const source = logGroup.split("/").pop()!;

    const streamsData = (await logsRequest("DescribeLogStreams", {
      logGroupName: logGroup,
      orderBy: "LastEventTime",
      descending: true,
    })) as {
      logStreams?: { logStreamName: string }[];
    };

    for (const stream of streamsData.logStreams ?? []) {
      const logsData = (await logsRequest("GetLogEvents", {
        logGroupName: logGroup,
        logStreamName: stream.logStreamName,
      })) as {
        events?: { message: string }[];
      };

      for (const logEvent of logsData.events ?? []) {
        const parsed = tryParseLogEvent(logEvent.message, source);
        if (parsed) events.push(parsed);
      }
    }
  }

  return events;
}

function tryParseLogEvent(
  message: string,
  source: string,
): LogEvent | undefined {
  try {
    const parsed = JSON.parse(message) as {
      message?: string;
      order?: number;
      received_at?: number;
    };

    if (
      parsed.message?.includes("Event processed") &&
      typeof parsed.order === "number" &&
      typeof parsed.received_at === "number"
    ) {
      return {
        message: parsed.message,
        order: parsed.order,
        received_at: parsed.received_at,
        source,
      };
    }
  } catch {
    // Not a JSON log line
  }
  return undefined;
}

function printResults(events: LogEvent[], stackName: StackName): void {
  const sorted = [...events].sort((a, b) => a.received_at - b.received_at);
  const earliest = sorted[0]?.received_at ?? 0;

  console.log("");
  console.log(
    "================================================================================",
  );
  console.log(`  RESULTS: ${stackName}`);
  console.log(
    "================================================================================",
  );
  console.log("");
  console.log(
    "  Events sorted by received_at (the timestamp each Lambda recorded):",
  );
  console.log("");
  console.log(
    `  ${"order".padEnd(8)}${"received_at".padEnd(20)}${"offset".padEnd(12)}${"processed by".padEnd(25)}path`,
  );
  console.log(`  ${"-".repeat(75)}`);

  for (const event of sorted) {
    const offset = `+${((event.received_at - earliest) / 1000).toFixed(1)}s`;
    const isDlq = event.source.includes("dlq");
    const path = isDlq
      ? "API -> SQS -> fail -> DLQ -> reprocessed"
      : "API -> SQS -> processed normally";

    console.log(
      `  ${String(event.order).padEnd(8)}${String(event.received_at).padEnd(20)}${offset.padEnd(12)}${event.source.padEnd(25)}${path}`,
    );
  }

  console.log(`  ${"-".repeat(75)}`);
  console.log("");

  const orderSequence = sorted.map((e) => e.order);
  const isChronological =
    orderSequence.length === 3 &&
    JSON.stringify(orderSequence) === JSON.stringify([1, 2, 3]);

  if (isChronological) {
    console.log("  VERDICT: Chronological order PRESERVED [1, 2, 3]");
    console.log("");
    console.log(
      "  Event 1 was reprocessed from the DLQ, but its received_at still reflects",
    );
    console.log(
      "  the ORIGINAL arrival time. Sorting by received_at gives the correct order.",
    );
  } else {
    console.log(
      `  VERDICT: Chronological order BROKEN — expected [1,2,3], got [${orderSequence.join(",")}]`,
    );
    console.log("");
    console.log(
      "  Event 1 arrived FIRST but appears LAST because received_at was set when the",
    );
    console.log(
      "  DLQ processor ran (seconds later), not when the event originally arrived.",
    );
    console.log(
      "  Any system relying on received_at for ordering will see events out of order.",
    );
  }

  console.log("");
  console.log(
    "================================================================================",
  );
  console.log("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countdown(totalMs: number, label: string): Promise<void> {
  const steps = Math.ceil(totalMs / 1000);
  for (let i = steps; i > 0; i--) {
    process.stdout.write(`\r       ${label} (${i}s remaining)...`);
    await sleep(1000);
  }
  process.stdout.write(`\r       ${label}... done.          \n`);
}

async function main(): Promise<void> {
  const stackName = process.argv[2] as StackName | undefined;

  if (!stackName || !(stackName in STACKS)) {
    console.error(
      `Usage: tsx scripts/simulate.ts <${Object.keys(STACKS).join("|")}>`,
    );
    process.exit(1);
  }

  const apiUrl = await getApiUrl(stackName);

  console.log("       Sending 3 events to the API Gateway endpoint:");
  console.log("");
  await sendEvents(apiUrl);
  console.log("");

  await countdown(
    PROCESSING_WAIT_MS,
    "Waiting for SQS to deliver messages to the Processor Lambda",
  );

  await countdown(
    DLQ_WAIT_MS,
    "Waiting for failed Event 1 to move to DLQ and be reprocessed",
  );

  console.log("");
  console.log("[4/4] Collecting results from CloudWatch Logs...");

  let events = await fetchLogs(stackName);

  if (events.length < EVENTS.length) {
    console.error(
      `Only ${events.length}/${EVENTS.length} events found in CloudWatch Logs. DLQ may need more time.`,
    );
    console.error("Retrying in 15s...");
    await sleep(15_000);
    events = await fetchLogs(stackName);
  }

  if (events.length === 0) {
    console.error("No events found in CloudWatch Logs.");
    process.exit(1);
  }

  printResults(events, stackName);
}

main();
