import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TagValue } from '../schema/common.js';
import type {
  DeploymentDefaultsFile,
  GuestDeploymentFile,
} from '../schema/deployment.js';
import type { FilemappingsFile } from '../schema/filemappings.js';
import { loadYamlDocument } from '../yaml/document.js';
import {
  mergeGuestDeployment,
  mergeGuestFilemappings,
  MergeValidationError,
} from './guest-merge.js';
import { mergeConfigs } from './merge.js';
import type { MergeSource } from './types.js';

const exampleDataDir = resolve(__dirname, '../../../../examples/data');

describe('Inheritance & Merge Engine', () => {
  describe('Basic merging and explicit null removal', () => {
    it('merges simple objects with override taking precedence', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: { cpu: 2, ram: 2048, protection: true },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: { ram: 4096, name: 'my-guest' },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged).toEqual({
        cpu: 2,
        ram: 4096,
        protection: true,
        name: 'my-guest',
      });

      expect(provenance.get('cpu')?.layer).toBe('default');
      expect(provenance.get('cpu')?.file).toBe('defaults.yaml');
      expect(provenance.get('cpu')?.value).toBe(2);

      expect(provenance.get('ram')?.layer).toBe('override');
      expect(provenance.get('ram')?.file).toBe('guest.yaml');
      expect(provenance.get('ram')?.value).toBe(4096);

      expect(provenance.get('protection')?.layer).toBe('default');
      expect(provenance.get('name')?.layer).toBe('override');
    });

    it('removes inherited key when override sets explicit null', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          cpu: 2,
          gateway: '192.168.1.1',
          ssh: { enabled: true, port: 22 },
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          gateway: null,
          ssh: { port: null },
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged).toEqual({
        cpu: 2,
        ssh: { enabled: true },
      });
      expect('gateway' in merged).toBe(false);
      expect('port' in (merged.ssh as Record<string, unknown>)).toBe(false);

      expect(provenance.removedKeys).toHaveLength(2);
      expect(provenance.removedKeys).toContainEqual({
        path: ['gateway'],
        pathString: 'gateway',
        layer: 'override',
        file: 'guest.yaml',
      });
      expect(provenance.removedKeys).toContainEqual({
        path: ['ssh', 'port'],
        pathString: 'ssh.port',
        layer: 'override',
        file: 'guest.yaml',
      });
    });

    it('removes entire nested object when override sets it to null', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: { cpu: 2, ssh: { enabled: true, port: 22 } },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: { ssh: null },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged).toEqual({ cpu: 2 });
      expect('ssh' in merged).toBe(false);
      expect(provenance.removedKeys).toContainEqual({
        path: ['ssh'],
        pathString: 'ssh',
        layer: 'override',
        file: 'guest.yaml',
      });
    });
  });

  describe('List semantics', () => {
    it('replaces lists by default (disks, tags, mounts, etc.)', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          tags: ['prod', 'linux'],
          disks: [{ name: 'rootfs', storage: 'local', size_gb: 10 }],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          tags: ['web'],
          disks: [{ name: 'rootfs', storage: 'zfs', size_gb: 20 }],
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.tags).toEqual(['web']);
      expect(merged.disks).toEqual([
        { name: 'rootfs', storage: 'zfs', size_gb: 20 },
      ]);

      expect(provenance.get('tags[0]')?.layer).toBe('override');
      expect(provenance.get('tags[0]')?.value).toBe('web');
      expect(provenance.get('disks[0].storage')?.layer).toBe('override');
      expect(provenance.get('disks[0].storage')?.value).toBe('zfs');
    });

    it('inherits default list when override does not specify it', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: { tags: ['base', 'linux'] },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: { cpu: 4 },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.tags).toEqual(['base', 'linux']);
      expect(provenance.get('tags[0]')?.layer).toBe('default');
      expect(provenance.get('tags[1]')?.layer).toBe('default');
    });

    it('supports opt-in append ($append)', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          tags: ['base', 'infra'],
          ssh: {
            authorized_keys: ['ssh-ed25519 key-admin'],
          },
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          tags: {
            $append: ['dns-service', 'monitoring'],
          },
          ssh: {
            authorized_keys: {
              $append: ['ssh-ed25519 key-dev'],
            },
          },
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.tags).toEqual([
        'base',
        'infra',
        'dns-service',
        'monitoring',
      ]);
      expect(
        (merged.ssh as { authorized_keys: string[] }).authorized_keys,
      ).toEqual(['ssh-ed25519 key-admin', 'ssh-ed25519 key-dev']);

      expect(provenance.get('tags[0]')?.layer).toBe('default');
      expect(provenance.get('tags[1]')?.layer).toBe('default');
      expect(provenance.get('tags[2]')?.layer).toBe('override');
      expect(provenance.get('tags[2]')?.sourcePath).toEqual([
        'tags',
        '$append',
        0,
      ]);
      expect(provenance.get('tags[3]')?.layer).toBe('override');
      expect(provenance.get('tags[3]')?.sourcePath).toEqual([
        'tags',
        '$append',
        1,
      ]);

      expect(provenance.get('ssh.authorized_keys[0]')?.layer).toBe('default');
      expect(provenance.get('ssh.authorized_keys[1]')?.layer).toBe('override');
    });

    it('supports opt-in prepend ($prepend) and explicit replace ($replace)', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          listA: ['two', 'three'],
          listB: ['orig'],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          listA: { $prepend: ['zero', 'one'] },
          listB: { $replace: ['replaced'] },
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.listA).toEqual(['zero', 'one', 'two', 'three']);
      expect(merged.listB).toEqual(['replaced']);

      expect(provenance.get('listA[0]')?.layer).toBe('override');
      expect(provenance.get('listA[1]')?.layer).toBe('override');
      expect(provenance.get('listA[2]')?.layer).toBe('default');
      expect(provenance.get('listA[3]')?.layer).toBe('default');
    });

    it('handles $append when default list does not exist', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: { cpu: 2 },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: { tags: { $append: ['first'] } },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.tags).toEqual(['first']);
      expect(provenance.get('tags[0]')?.layer).toBe('override');
    });
  });

  describe('Network list identity merging', () => {
    it('merges network entries by index', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          network: [
            {
              index: 0,
              name: 'eth0',
              bridge: 'vmbr0',
              gateway: '192.168.1.1',
              firewall: true,
            },
            {
              index: 1,
              name: 'eth1',
              bridge: 'vmbr1',
            },
          ],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          network: [
            {
              index: 0,
              ip: '192.168.1.50/24',
              mac: '00:11:22:33:44:55',
            },
            {
              index: 2,
              name: 'eth2',
              bridge: 'vmbr2',
              ip: '10.0.0.2/24',
            },
          ],
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );
      const net = merged.network as Record<string, unknown>[];

      expect(net).toHaveLength(3);

      // Interface 0: merged from default + override
      expect(net[0]).toEqual({
        index: 0,
        name: 'eth0',
        bridge: 'vmbr0',
        gateway: '192.168.1.1',
        firewall: true,
        ip: '192.168.1.50/24',
        mac: '00:11:22:33:44:55',
      });
      expect(provenance.get('network[0].bridge')?.layer).toBe('default');
      expect(provenance.get('network[0].gateway')?.layer).toBe('default');
      expect(provenance.get('network[0].ip')?.layer).toBe('override');
      expect(provenance.get('network[0].mac')?.layer).toBe('override');

      // Interface 1: inherited from default
      expect(net[1]).toEqual({
        index: 1,
        name: 'eth1',
        bridge: 'vmbr1',
      });
      expect(provenance.get('network[1].bridge')?.layer).toBe('default');

      // Interface 2: added from override
      expect(net[2]).toEqual({
        index: 2,
        name: 'eth2',
        bridge: 'vmbr2',
        ip: '10.0.0.2/24',
      });
      expect(provenance.get('network[2].bridge')?.layer).toBe('override');
      expect(provenance.get('network[2].ip')?.layer).toBe('override');
    });

    it('merges network entries by name when index is not specified', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          network: [{ name: 'wan', bridge: 'vmbr0', firewall: true }],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          network: [{ name: 'wan', ip: 'dhcp' }],
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );
      const net = merged.network as Record<string, unknown>[];

      expect(net).toHaveLength(1);
      expect(net[0]).toEqual({
        name: 'wan',
        bridge: 'vmbr0',
        firewall: true,
        ip: 'dhcp',
      });
      expect(provenance.get('network[0].bridge')?.layer).toBe('default');
      expect(provenance.get('network[0].ip')?.layer).toBe('override');
    });

    it('allows removing an inherited network entry with _remove: true', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          network: [
            { index: 0, bridge: 'vmbr0' },
            { index: 1, bridge: 'vmbr1' },
          ],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          network: [{ index: 1, _remove: true }],
        },
      };

      const { merged } = mergeConfigs<Record<string, unknown>>(def, ovr);
      const net = merged.network as Record<string, unknown>[];

      expect(net).toHaveLength(1);
      expect(net[0]?.index).toBe(0);
    });

    it('replaces network completely when override passes an empty array', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          network: [{ index: 0, bridge: 'vmbr0' }],
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          network: [],
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );
      expect(merged.network).toEqual([]);
      expect(provenance.get('network')?.layer).toBe('override');
    });
  });

  describe('Tag awareness and CST node preservation', () => {
    it('preserves unevaluated tags and tracks tag provenance', () => {
      const tagSecret: TagValue = { tag: 'secret', value: 'my_secret' };
      const tagExpr: TagValue = { tag: 'expr', value: '1 + 1' };

      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: {
          password: tagSecret,
        },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: {
          mac: tagExpr,
        },
      };

      const { merged, provenance } = mergeConfigs<Record<string, unknown>>(
        def,
        ovr,
      );

      expect(merged.password).toEqual(tagSecret);
      expect(merged.mac).toEqual(tagExpr);

      const passProv = provenance.get('password');
      expect(passProv?.isTag).toBe(true);
      expect(passProv?.tag).toBe('secret');
      expect(passProv?.value).toEqual(tagSecret);

      const macProv = provenance.get('mac');
      expect(macProv?.isTag).toBe(true);
      expect(macProv?.tag).toBe('expr');
      expect(macProv?.value).toEqual(tagExpr);
    });

    it('attaches CST Nodes to provenance entries when Document is provided', () => {
      const defYaml = `
schema_version: 1
cpu: 2
ssh:
  password: !secret default_pw
`;
      const ovrYaml = `
schema_version: 1
name: guest-01
ssh:
  port: 2222
`;

      const defDoc = loadYamlDocument(defYaml);
      const ovrDoc = loadYamlDocument(ovrYaml);

      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: defDoc.toJS(),
        document: defDoc,
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: ovrDoc.toJS(),
        document: ovrDoc,
      };

      const { provenance } = mergeConfigs(def, ovr);

      const cpuProv = provenance.get('cpu');
      expect(cpuProv?.node).toBeDefined();

      const pwProv = provenance.get('ssh.password');
      expect(pwProv?.node).toBeDefined();
      expect(pwProv?.isTag).toBe(true);
      expect(pwProv?.tag).toBe('secret');

      const portProv = provenance.get('ssh.port');
      expect(portProv?.node).toBeDefined();
      expect(portProv?.layer).toBe('override');
    });
  });

  describe('Real fixtures from examples/data', () => {
    it('merges example-host default-deployment.yaml with 112-example-lxc deployment.yaml', async () => {
      const defPath = resolve(
        exampleDataDir,
        'hosts/example-host/default-deployment.yaml',
      );
      const lxcPath = resolve(
        exampleDataDir,
        'hosts/example-host/112-example-lxc/deployment.yaml',
      );

      const defContent = await readFile(defPath, 'utf8');
      const lxcContent = await readFile(lxcPath, 'utf8');

      const defDoc = loadYamlDocument(defContent);
      const lxcDoc = loadYamlDocument(lxcContent);

      const { deployment, provenance } = mergeGuestDeployment({
        defaultDeployment: {
          file: 'hosts/example-host/default-deployment.yaml',
          data: defDoc.toJS() as DeploymentDefaultsFile,
          document: defDoc,
        },
        guestDeployment: {
          file: 'hosts/example-host/112-example-lxc/deployment.yaml',
          data: lxcDoc.toJS() as GuestDeploymentFile,
          document: lxcDoc,
        },
      });

      expect(deployment.id).toBe(112);
      expect(deployment.name).toBe('example-lxc');
      expect(deployment.type).toBe('lxc');
      expect(deployment.cpu).toBe(2); // Inherited from default
      expect(deployment.ram).toBe(2048); // Inherited from default
      expect(deployment.protection).toBe(true); // Inherited from default
      expect(deployment.network).toHaveLength(1);

      // Network 0 has merged fields:
      const net0 = deployment.network[0]!;
      expect(net0.index).toBe(0);
      expect(net0.name).toBe('eth0'); // default
      expect(net0.bridge).toBe('vmbr0'); // default
      expect(net0.gateway).toEqual({ tag: 'env', value: 'EXAMPLE_GATEWAY' }); // default tag
      expect(net0.ip).toBe('192.0.2.112/24'); // override
      expect(net0.mac).toEqual({
        tag: 'expr',
        value: "mac('A2:B1:C1', host.index, net.index, vmid)",
      }); // override tag

      // Provenance checks:
      expect(provenance.get('cpu')?.layer).toBe('default');
      expect(provenance.get('cpu')?.file).toBe(
        'hosts/example-host/default-deployment.yaml',
      );
      expect(provenance.get('id')?.layer).toBe('override');
      expect(provenance.get('network[0].bridge')?.layer).toBe('default');
      expect(provenance.get('network[0].ip')?.layer).toBe('override');
      expect(provenance.get('network[0].mac')?.isTag).toBe(true);
      expect(provenance.get('network[0].mac')?.tag).toBe('expr');

      // Check CST nodes exist
      expect(provenance.get('network[0].mac')?.node).toBeDefined();
      expect(provenance.get('network[0].gateway')?.node).toBeDefined();
    });

    it('merges example-host default-deployment.yaml with 212-example-vm deployment.yaml', async () => {
      const defPath = resolve(
        exampleDataDir,
        'hosts/example-host/default-deployment.yaml',
      );
      const vmPath = resolve(
        exampleDataDir,
        'hosts/example-host/212-example-vm/deployment.yaml',
      );

      const defContent = await readFile(defPath, 'utf8');
      const vmContent = await readFile(vmPath, 'utf8');

      const defDoc = loadYamlDocument(defContent);
      const vmDoc = loadYamlDocument(vmContent);

      const { deployment, provenance } = mergeGuestDeployment({
        defaultDeployment: {
          file: 'hosts/example-host/default-deployment.yaml',
          data: defDoc.toJS() as DeploymentDefaultsFile,
          document: defDoc,
        },
        guestDeployment: {
          file: 'hosts/example-host/212-example-vm/deployment.yaml',
          data: vmDoc.toJS() as GuestDeploymentFile,
          document: vmDoc,
        },
      });

      expect(deployment.id).toBe(212);
      expect(deployment.name).toBe('example-vm');
      expect(deployment.type).toBe('vm');
      expect(deployment.cpu).toBe(4); // Overridden in guest
      expect(deployment.ram).toBe(4096); // Overridden in guest

      expect(provenance.get('cpu')?.layer).toBe('override');
      expect(provenance.get('ram')?.layer).toBe('override');
      expect(provenance.get('protection')?.layer).toBe('default');
    });

    it('throws MergeValidationError if merged deployment fails schema validation', () => {
      expect(() =>
        mergeGuestDeployment({
          guestDeployment: {
            file: 'invalid.yaml',
            data: {
              schema_version: 1,
              id: 999,
              name: 'invalid',
              type: 'lxc',
              // missing cpu, ram, disks, network
            } as unknown as GuestDeploymentFile,
          },
        }),
      ).toThrow(MergeValidationError);
    });

    it('merges default and guest filemappings', async () => {
      const defPath = resolve(
        exampleDataDir,
        'hosts/example-host/default-filemappings.yaml',
      );
      const lxcPath = resolve(
        exampleDataDir,
        'hosts/example-host/112-example-lxc/filemappings.yaml',
      );

      const defDoc = loadYamlDocument(await readFile(defPath, 'utf8'));
      const lxcDoc = loadYamlDocument(await readFile(lxcPath, 'utf8'));

      const { filemappings, provenance } = mergeGuestFilemappings({
        defaultFilemappings: {
          file: 'hosts/example-host/default-filemappings.yaml',
          data: defDoc.toJS() as FilemappingsFile,
          document: defDoc,
        },
        guestFilemappings: {
          file: 'hosts/example-host/112-example-lxc/filemappings.yaml',
          data: lxcDoc.toJS() as FilemappingsFile,
          document: lxcDoc,
        },
      });

      expect(filemappings.mappings).toHaveLength(1);
      expect(
        (filemappings.mappings[0] as { destination: string })?.destination,
      ).toBe('/etc/example.conf');
      expect(provenance.get('mappings[0].destination')?.layer).toBe('override');
    });

    it('supports validate: false for mergeGuestDeployment', () => {
      const res = mergeGuestDeployment({
        guestDeployment: {
          file: 'incomplete.yaml',
          data: {
            schema_version: 1,
            id: 101,
            name: 'test',
            type: 'lxc',
          } as unknown as GuestDeploymentFile,
        },
        validate: false,
      });
      expect(res.deployment.name).toBe('test');
    });

    it('supports validate: false and handles errors for mergeGuestFilemappings', () => {
      expect(() =>
        mergeGuestFilemappings({
          guestFilemappings: {
            file: 'invalid.yaml',
            data: { invalid_key: true } as unknown as FilemappingsFile,
          },
        }),
      ).toThrow(MergeValidationError);

      const unvalidated = mergeGuestFilemappings({
        guestFilemappings: {
          file: 'invalid.yaml',
          data: { invalid_key: true } as unknown as FilemappingsFile,
        },
        validate: false,
      });
      expect(
        (unvalidated.filemappings as unknown as { invalid_key: boolean })
          .invalid_key,
      ).toBe(true);
    });

    it('merges filemappings when only default or only guest is provided', () => {
      const onlyDefault = mergeGuestFilemappings({
        defaultFilemappings: {
          file: 'def.yaml',
          data: { schema_version: 1, mappings: [] },
        },
      });
      expect(onlyDefault.filemappings.mappings).toEqual([]);

      const onlyGuest = mergeGuestFilemappings({
        guestFilemappings: {
          file: 'guest.yaml',
          data: { schema_version: 1, mappings: [] },
        },
      });
      expect(onlyGuest.filemappings.mappings).toEqual([]);
    });

    it('handles modifier without default ($prepend and $replace)', () => {
      const prependRes = mergeConfigs(undefined, {
        file: 'g.yaml',
        layer: 'override',
        data: { list: { $prepend: ['a', 'b'] } },
      });
      expect((prependRes.merged as { list: string[] }).list).toEqual([
        'a',
        'b',
      ]);

      const replaceRes = mergeConfigs(undefined, {
        file: 'g.yaml',
        layer: 'override',
        data: { list: { $replace: ['x'] } },
      });
      expect((replaceRes.merged as { list: string[] }).list).toEqual(['x']);
    });

    it('handles unmatched network override item with _remove: true', () => {
      const res = mergeConfigs(
        {
          file: 'def.yaml',
          layer: 'default',
          data: { network: [{ index: 0, bridge: 'vmbr0' }] },
        },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: {
            network: [{ index: 99, _remove: true }],
          },
        },
      );
      expect((res.merged as { network: unknown[] }).network).toHaveLength(1);
    });

    it('handles non-object and non-keyed items in identity list', () => {
      const res = mergeConfigs(
        {
          file: 'def.yaml',
          layer: 'default',
          data: { network: ['raw-string-1'] },
        },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: { network: ['raw-string-2'] },
        },
      );
      expect((res.merged as { network: unknown[] }).network).toHaveLength(2);
    });

    it('gracefully handles CstNode lookup errors in resolveCstNode', () => {
      const fakeDoc = {
        getIn: () => {
          throw new Error('CST lookup error');
        },
      };
      const res = mergeConfigs(undefined, {
        file: 'ovr.yaml',
        layer: 'override',
        data: { a: 1 },
        document: fakeDoc as unknown as import('yaml').Document,
      });
      expect(res.provenance.get('a')?.node).toBeUndefined();
    });

    it('handles various edge case branch paths in merge engine', () => {
      // 1. Both sources undefined
      const empty = mergeConfigs(undefined, undefined);
      expect(empty.merged).toBeUndefined();

      // 2. Custom identityMergedLists as path array
      const customIdentity = mergeConfigs(
        {
          file: 'def.yaml',
          layer: 'default',
          data: { custom: [{ index: 0, a: 1 }] },
        },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: { custom: [{ index: 0, b: 2 }] },
        },
        { identityMergedLists: [['custom']] },
      );
      expect((customIdentity.merged as { custom: unknown[] }).custom).toEqual([
        { index: 0, a: 1, b: 2 },
      ]);

      // 3. $append and $prepend on non-array default values
      const appendNonArray = mergeConfigs(
        { file: 'def.yaml', layer: 'default', data: { list: 'not-array' } },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: { list: { $append: ['item1'] } },
        },
      );
      expect((appendNonArray.merged as { list: string[] }).list).toEqual([
        'item1',
      ]);

      const prependNonArray = mergeConfigs(
        { file: 'def.yaml', layer: 'default', data: { list: 'not-array' } },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: { list: { $prepend: ['item1'] } },
        },
      );
      expect((prependNonArray.merged as { list: string[] }).list).toEqual([
        'item1',
      ]);

      // 4. getItemKey with null index and name
      const nullIdxName = mergeConfigs(
        {
          file: 'def.yaml',
          layer: 'default',
          data: { network: [{ index: null, name: null, foo: 1 }] },
        },
        {
          file: 'ovr.yaml',
          layer: 'override',
          data: { network: [{ index: null, name: null, bar: 2 }] },
        },
      );
      expect(
        (nullIdxName.merged as { network: unknown[] }).network,
      ).toHaveLength(2);

      // 5. Undefined override value when defaultSource is undefined
      const defSourceMissing = mergeConfigs(undefined, {
        file: 'ovr.yaml',
        layer: 'override',
        data: { missing: undefined },
      });
      expect(
        (defSourceMissing.merged as Record<string, unknown>).missing,
      ).toBeUndefined();
    });
  });

  describe('Property-based testing (fast-check)', () => {
    const safeJsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      val: fc.oneof(
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie('val'), { maxLength: 3 }),
        fc.dictionary(
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          tie('val'),
          { maxKeys: 3 },
        ),
      ),
    })).val;

    it('satisfies identity laws: merging with undefined returns input unchanged', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/),
            safeJsonValue,
          ),
          (dict) => {
            const src: MergeSource = {
              file: 'a.yaml',
              layer: 'override',
              data: dict,
            };

            const { merged, provenance } = mergeConfigs<
              Record<string, unknown>
            >(undefined, src);
            expect(merged).toEqual(dict);

            for (const key of Object.keys(dict)) {
              if (dict[key] !== undefined) {
                expect(provenance.has(key)).toBe(true);
                expect(provenance.get(key)?.layer).toBe('override');
              }
            }
          },
        ),
      );
    });

    it('property: explicit null always removes an inherited scalar key', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          safeJsonValue,
          (key, val) => {
            if (val === null || val === undefined) return true;

            const def: MergeSource = {
              file: 'def.yaml',
              layer: 'default',
              data: { [key]: val },
            };
            const ovr: MergeSource = {
              file: 'ovr.yaml',
              layer: 'override',
              data: { [key]: null },
            };

            const { merged, provenance } = mergeConfigs<
              Record<string, unknown>
            >(def, ovr);
            expect(key in merged).toBe(false);
            expect(provenance.removedKeys).toContainEqual(
              expect.objectContaining({ path: [key], layer: 'override' }),
            );
            return true;
          },
        ),
      );
    });

    it('property: non-identity list replacement ensures complete override', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string()),
          fc.array(fc.string()),
          (defList, ovrList) => {
            const def: MergeSource = {
              file: 'def.yaml',
              layer: 'default',
              data: { tags: defList },
            };
            const ovr: MergeSource = {
              file: 'ovr.yaml',
              layer: 'override',
              data: { tags: ovrList },
            };

            const { merged, provenance } = mergeConfigs<
              Record<string, unknown>
            >(def, ovr);
            expect(merged.tags).toEqual(ovrList);

            for (let i = 0; i < ovrList.length; i++) {
              expect(provenance.get(`tags[${i}]`)?.layer).toBe('override');
              expect(provenance.get(`tags[${i}]`)?.value).toBe(ovrList[i]);
            }
          },
        ),
      );
    });

    it('property: opt-in $append concatenates lists and preserves provenance layers', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string()),
          fc.array(fc.string()),
          (defList, appendList) => {
            const def: MergeSource = {
              file: 'def.yaml',
              layer: 'default',
              data: { tags: defList },
            };
            const ovr: MergeSource = {
              file: 'ovr.yaml',
              layer: 'override',
              data: { tags: { $append: appendList } },
            };

            const { merged, provenance } = mergeConfigs<
              Record<string, unknown>
            >(def, ovr);
            const expected = [...defList, ...appendList];
            expect(merged.tags).toEqual(expected);

            for (let i = 0; i < defList.length; i++) {
              expect(provenance.get(`tags[${i}]`)?.layer).toBe('default');
            }
            for (let j = 0; j < appendList.length; j++) {
              expect(provenance.get(`tags[${defList.length + j}]`)?.layer).toBe(
                'override',
              );
            }
          },
        ),
      );
    });

    it('property: network index identity merge preserves non-conflicting default fields', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 31 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (idx, bridge, ip) => {
            const def: MergeSource = {
              file: 'def.yaml',
              layer: 'default',
              data: {
                network: [{ index: idx, bridge }],
              },
            };
            const ovr: MergeSource = {
              file: 'ovr.yaml',
              layer: 'override',
              data: {
                network: [{ index: idx, ip }],
              },
            };

            const { merged, provenance } = mergeConfigs<
              Record<string, unknown>
            >(def, ovr);
            const net = (merged.network as Record<string, unknown>[])[0]!;

            expect(net.index).toBe(idx);
            expect(net.bridge).toBe(bridge);
            expect(net.ip).toBe(ip);

            expect(provenance.get('network[0].bridge')?.layer).toBe('default');
            expect(provenance.get('network[0].ip')?.layer).toBe('override');
          },
        ),
      );
    });
  });

  describe('ProvenanceMap utility queries', () => {
    it('supports queries byFile, byLayer, and entries', () => {
      const def: MergeSource = {
        file: 'defaults.yaml',
        layer: 'default',
        data: { a: 1, b: 2 },
      };
      const ovr: MergeSource = {
        file: 'guest.yaml',
        layer: 'override',
        data: { b: 20, c: 30 },
      };

      const { provenance } = mergeConfigs(def, ovr);

      expect(provenance.byFile('defaults.yaml')).toHaveLength(1);
      expect(provenance.byFile('guest.yaml')).toHaveLength(3); // container object + b + c

      expect(provenance.byLayer('default')).toHaveLength(1);
      expect(provenance.byLayer('override')).toHaveLength(3);
      expect(provenance.entries().length).toBeGreaterThanOrEqual(3);
    });
  });
});
