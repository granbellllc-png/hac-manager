export class ProxmoxApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
    public readonly responseBody?: unknown | undefined,
  ) {
    super(`Proxmox API Error (${statusCode}): ${message}`);
    this.name = 'ProxmoxApiError';
  }
}

export class ProxmoxTaskError extends Error {
  public constructor(
    public readonly upid: string,
    public readonly exitStatus: string,
  ) {
    super(`Proxmox task '${upid}' failed with status: ${exitStatus}`);
    this.name = 'ProxmoxTaskError';
  }
}

export class TlsFingerprintMismatchError extends Error {
  public constructor(
    public readonly host: string,
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super(
      `TLS certificate fingerprint mismatch for ${host}: expected '${expectedFingerprint}', got '${actualFingerprint}'.`,
    );
    this.name = 'TlsFingerprintMismatchError';
  }
}
