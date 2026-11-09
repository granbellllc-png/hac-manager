import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProxmoxClient } from './client.js';

const fixtureDir = join(import.meta.dirname, '../../fixtures/tls');
const cert = readFileSync(join(fixtureDir, 'fixture-cert.pem'), 'utf8');
const key = readFileSync(join(fixtureDir, 'fixture-key.pem'), 'utf8');
const fingerprint = new X509Certificate(cert).fingerprint256;

describe('Proxmox API TLS trust over a real loopback handshake', () => {
  it.each([
    { name: 'system trust rejects a self-signed certificate', accepts: false },
    {
      name: 'matching pin accepts the certificate',
      pin: `SHA256: ${fingerprint.toLowerCase()}`,
      accepts: true,
    },
    {
      name: 'mismatched pin blocks the request',
      pin: '00'.repeat(32),
      accepts: false,
    },
    { name: 'custom CA accepts the certificate', ca: cert, accepts: true },
    {
      name: 'invalid CA rejects the certificate',
      ca: 'invalid fixture CA',
      accepts: false,
    },
    {
      name: 'a CA does not bypass a configured pin',
      ca: cert,
      pin: '11'.repeat(32),
      accepts: false,
    },
  ])('$name', async ({ pin, ca, accepts }) => {
    let requestCount = 0;
    const server = createServer({ key, cert }, (_request, response) => {
      requestCount++;
      response.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      response.end(
        JSON.stringify({ data: [{ node: 'fixture', status: 'online' }] }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture server failed to bind');
    const client = new ProxmoxClient({
      baseUrl: `https://127.0.0.1:${address.port}`,
      pinnedFingerprint: pin,
      caCertificate: ca,
      auth: {
        type: 'token',
        tokenId: 'fixture!test',
        tokenSecret: 'fixture-token',
      },
    });
    try {
      if (accepts) {
        expect(await client.getNodes()).toEqual([
          { node: 'fixture', status: 'online' },
        ]);
        expect(requestCount).toBe(1);
      } else {
        await expect(client.getNodes()).rejects.toThrow();
        expect(requestCount).toBe(0);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
