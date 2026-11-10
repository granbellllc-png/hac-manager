import type { AuthenticatedUser } from '../auth/session.js';

export interface ConsoleOpenRequest {
  readonly hostId: string;
  readonly target: 'host' | 'lxc';
  readonly vmid?: number | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly recording: boolean;
}

export interface ConsoleSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface ConsoleSessionContext {
  readonly user: AuthenticatedUser;
  readonly request: ConsoleOpenRequest;
}

export type ConsoleClientMessage =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ping' };
