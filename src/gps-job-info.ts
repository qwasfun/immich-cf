export interface GpsFailure {
  id: string;
  seq: number;
  filename: string;
  code: string;
  message: string;
  tries: number;
}
export interface GpsJob {
  id: string;
  scope: string;
  sourceName: string;
  total: number;
  state: 'running' | 'paused' | 'complete' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  pending: number;
  succeeded: number;
  located: number;
  noGps: number;
  skipped: number;
  failed: number;
  processed: number;
  leaseUntil: number;
  currentFile: string | null;
  lastResult: { filename: string; state: string; message: string | null } | null;
  failures: GpsFailure[];
  nextFailure: number | null;
}
export interface GpsPlan {
  count: number;
  version: string;
  scope: string;
  sourceName: string;
}
