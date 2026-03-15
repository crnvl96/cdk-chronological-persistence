import {
  DLQ_WAIT_MS,
  EVENTS,
  LOCALSTACK_ENDPOINT,
  PROCESSING_WAIT_MS,
  SEND_DELAY_MS,
  STACKS,
} from "./constants.js";
import type {
  DescribeLogStreamsResponse,
  GetLogEventsResponse,
  LogEvent,
  ParsedLogMessage,
  StackName,
} from "./types.js";

export class Simulate {
  async run(stackName?: StackName) {
    const resolvedStackName =
      stackName ?? this.validateStackName(process.argv[2]);
    const apiUrl = await this.getAPIURL(resolvedStackName);

    this.printIndented("Sending 3 events to the API Gateway endpoint:", "");
    await this.sendEvents(apiUrl);
    this.printNewLine();

    await this.countdown(
      PROCESSING_WAIT_MS,
      "Waiting for SQS to deliver messages to the Processor Lambda",
    );

    await this.countdown(
      DLQ_WAIT_MS,
      "Waiting for failed Event 1 to move to DLQ and be reprocessed",
    );

    this.printNewLine();
    console.log("[4/4] Collecting results from CloudWatch Logs...");

    let events = await this.fetchLogs(resolvedStackName);

    if (events.length < EVENTS.length) {
      console.error(
        `Only ${events.length}/${EVENTS.length} events found in CloudWatch Logs. DLQ may need more time.`,
      );
      console.error(`Retrying in ${DLQ_WAIT_MS}s...`);
      await this.sleep(DLQ_WAIT_MS);
      events = await this.fetchLogs(resolvedStackName);
    }

    if (events.length === 0) {
      console.error("No events found in CloudWatch Logs.");
      process.exit(1);
    }

    this.printResults(events, resolvedStackName);
  }

  async getAPIURL(stackName: StackName): Promise<string> {
    const config = STACKS[stackName];
    const endpoint = `${LOCALSTACK_ENDPOINT}/?Action=DescribeStacks&StackName=${stackName}`;
    const response = await fetch(endpoint);
    const xml = await response.text();

    const pattern = `<OutputValue>([^<]+)</OutputValue>[\\s\\S]*?<ExportName>${config.exportName}</ExportName>`;
    const regex = new RegExp(pattern);
    const match = regex.exec(xml);

    if (!match) {
      throw new Error(
        `Export "${config.exportName}" not found in DescribeStacks response`,
      );
    }

    return match[1]!;
  }

  async sendEvents(apiUrl: string): Promise<void> {
    const eventsUrl = `${apiUrl}events`;

    for (const event of EVENTS) {
      const failNote =
        "simulateFailure" in event
          ? " (will FAIL on purpose -> goes to DLQ)"
          : "";

      this.printIndented(
        `Event ${event.order}: sending...${failNote}`,
        `Sending Event ${event} to ${eventsUrl}`,
      );

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

      const lastEvent = EVENTS[EVENTS.length - 1];

      if (event !== lastEvent) {
        await this.sleep(SEND_DELAY_MS);
      }
    }
  }

  async countdown(totalMs: number, label: string): Promise<void> {
    const steps = Math.ceil(totalMs / 1000);

    for (let i = steps; i > 0; i--) {
      process.stdout.write(`\r\t${label} (${i}s remaining)...`);
      await this.sleep(1000);
    }

    process.stdout.write(`\r\t${label}... done.\t\n`);
  }

  async fetchLogs(stackName: StackName): Promise<LogEvent[]> {
    const config = STACKS[stackName];
    const events: LogEvent[] = [];

    for (const logGroup of config.logGroups) {
      const source = logGroup.split("/").pop()!;

      const streamsDataBody = {
        logGroupName: logGroup,
        orderBy: "LastEventTime",
        descending: true,
      };

      const streamsData = await this.logsRequest<DescribeLogStreamsResponse>(
        "DescribeLogStreams",
        streamsDataBody,
      );

      for (const stream of streamsData.logStreams ?? []) {
        const logsDataBody = {
          logGroupName: logGroup,
          logStreamName: stream.logStreamName,
        };

        const logsData = await this.logsRequest<GetLogEventsResponse>(
          "GetLogEvents",
          logsDataBody,
        );

        for (const logEvent of logsData.events ?? []) {
          const parsed = this.tryParseLogEvent(logEvent.message, source);
          if (parsed) events.push(parsed);
        }
      }
    }

    return events;
  }

  printResults(events: LogEvent[], stackName: StackName): void {
    const sorted = [...events].sort((a, b) => a.received_at - b.received_at);
    const earliest = sorted[0]?.received_at ?? 0;

    this.printNewLine();
    this.printSeparator();
    this.printIndented(`RESULTS: ${stackName}`);
    this.printSeparator();
    this.printNewLine();
    this.printIndented("Events sorted by received_at:", "");

    const columns = [
      { header: "order", width: 8 },
      { header: "received_at", width: 20 },
      { header: "offset", width: 12 },
      { header: "processed by", width: 25 },
      { header: "path" },
    ] as const;

    const rows = sorted.map((event) => {
      const offset = `+${((event.received_at - earliest) / 1000).toFixed(1)}s`;
      const isDlq = event.source.includes("dlq");
      const path = isDlq
        ? "API -> SQS -> fail -> DLQ -> reprocessed"
        : "API -> SQS -> processed normally";

      return [
        String(event.order),
        String(event.received_at),
        offset,
        event.source,
        path,
      ];
    });

    this.printResultsTable(columns, rows);

    this.printDivider(80);
    this.printNewLine();

    const orderSequence = sorted.map((e) => e.order);
    const isChronological =
      orderSequence.length === 3 &&
      JSON.stringify(orderSequence) === JSON.stringify([1, 2, 3]);

    if (isChronological) {
      this.printIndented(
        "VERDICT: Chronological order PRESERVED [1, 2, 3]",
        "",
        "Event 1 was reprocessed from the DLQ, but its received_at still reflects",
        "the ORIGINAL arrival time. Sorting by received_at gives the correct order.",
      );
    } else {
      this.printIndented(
        `VERDICT: Chronological order BROKEN — expected [1,2,3], got [${orderSequence.join(",")}]`,
        "",
        "Event 1 arrived FIRST but appears LAST because received_at was set when the",
        "DLQ processor ran (seconds later), not when the event originally arrived.",
        "Any system relying on received_at for ordering will see events out of order.",
      );
    }

    this.printNewLine();
    this.printSeparator();
    this.printNewLine();
  }

  private async logsRequest<T>(
    target: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = LOCALSTACK_ENDPOINT;
    const opts: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `Logs_20140328.${target}`,
      },
      body: JSON.stringify(body),
    };

    const response = await fetch(url, opts);
    return response.json() as T;
  }

  private isProcessedEvent(
    parsed: ParsedLogMessage,
  ): parsed is Required<ParsedLogMessage> {
    return (
      typeof parsed.message === "string" &&
      parsed.message.includes("Event processed") &&
      typeof parsed.order === "number" &&
      typeof parsed.received_at === "number"
    );
  }

  private tryParseLogEvent(
    message: string,
    source: string,
  ): LogEvent | undefined {
    const parsed = JSON.parse(message) as ParsedLogMessage;

    if (this.isProcessedEvent(parsed)) {
      return { ...parsed, source };
    }

    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private validateStackName(stackName: string | undefined): StackName {
    if (!stackName || !(stackName in STACKS)) {
      console.error(
        `Usage: tsx scripts/simulate.ts <${Object.keys(STACKS).join("|")}>`,
      );
      process.exit(1);
    }

    return stackName as StackName;
  }

  private printResultsTable(
    columns: ReadonlyArray<{ header: string; width?: number }>,
    rows: string[][],
  ) {
    const formatRow = (values: string[]) =>
      values
        .map((val, i) => {
          const width = columns[i]?.width;
          return width ? val.padEnd(width) : val;
        })
        .join("");

    this.printIndented(formatRow(columns.map((c) => c.header)));
    const totalWidth = columns.reduce(
      (sum, c) => sum + (c.width ?? c.header.length),
      0,
    );
    this.printDivider(totalWidth);

    for (const row of rows) {
      console.log(`  ${formatRow(row)}`);
    }
  }

  private printNewLine() {
    console.log("\n");
  }

  private printSeparator() {
    console.log("=".repeat(80));
  }

  private printDivider(length: number) {
    console.log(`\t${"-".repeat(length)}`);
  }

  private printIndented(...lines: string[]) {
    for (const line of lines) {
      console.log(`\t${line}`);
    }
  }
}

const simulate = new Simulate();
simulate.run();
