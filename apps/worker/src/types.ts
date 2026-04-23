export interface VideoJobPayload {
  jobId: string;
  inputKey: string;
  priority: number;
  payloadVersion: 1;
  userId?: string;
}
