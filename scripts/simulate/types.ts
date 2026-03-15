import type { STACKS } from "./constants.js";

export type StackName = keyof typeof STACKS;

export interface LogEvent {
  message: string;
  order: number;
  received_at: number;
  source: string;
}

export interface DescribeLogStreamsResponse {
  logStreams?: { logStreamName: string }[];
}

export interface GetLogEventsResponse {
  events?: { message: string }[];
}

export interface ParsedLogMessage {
  message?: string;
  order?: number;
  received_at?: number;
}
