import { SshConnection } from './connection.js';
import type { SshHostConfig } from './types.js';

export class SshPool {
  private readonly connections = new Map<string, SshConnection>();

  public get(hostId: string): SshConnection | undefined {
    return this.connections.get(hostId);
  }

  public getOrCreate(hostId: string, config: SshHostConfig): SshConnection {
    let connection = this.connections.get(hostId);
    if (!connection) {
      connection = new SshConnection(hostId, config);
      this.connections.set(hostId, connection);
    }
    return connection;
  }

  public async remove(hostId: string): Promise<void> {
    const conn = this.connections.get(hostId);
    if (conn) {
      this.connections.delete(hostId);
      await conn.disconnect();
    }
  }

  public async closeAll(): Promise<void> {
    const list = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(list.map((c) => c.disconnect()));
  }
}
