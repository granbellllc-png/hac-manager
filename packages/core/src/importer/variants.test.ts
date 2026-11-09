import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseLxcProxmoxConfig } from '../codec/lxc.js';
import { parseVmProxmoxConfig } from '../codec/vm.js';
import { deploymentDefaultsFileSchema } from '../schema/deployment.js';
import { defaultNodeFileSystem } from '../yaml/file.js';
import { WriteGuard } from '../data-dir/write-guard.js';
import { hashContent } from '../data-dir/hash.js';
import { generateDeploymentYaml } from './generate.js';
import { planGuestImport } from './plan.js';
import { applyGuestImport } from './apply.js';

describe('import configuration variants', () => {
  it.each(['lxc', 'vm'] as const)(
    'omits deeply equal %s defaults while keeping identity',
    (type) => {
      const parsed =
        type === 'lxc'
          ? parseLxcProxmoxConfig(
              'hostname: fixture\nswap: 128\nunprivileged: 1\nostype: debian\nfeatures: nesting=1,mount=nfs\nrootfs: local:disk,size=8G\nnet0: name=eth0\nmp0: /fixture,mp=/opt\ntags: fixture\n',
            )
          : parseVmProxmoxConfig(
              'name: fixture\nbios: ovmf\nmachine: q35\nagent: 1\nciuser: fixture\n',
            );
      const guest = {
        ...parsed,
        protection: true,
        tags: ['fixture'],
        extra: { fixture: { list: [1, 2] } },
      };
      const defaultFields = Object.fromEntries(
        Object.entries(guest).filter(
          ([key]) => !['id', 'name', 'type'].includes(key),
        ),
      );
      const defaults = deploymentDefaultsFileSchema.parse(defaultFields);
      const result = generateDeploymentYaml({ guest, defaults });
      expect(parse(result.yamlContent)).toEqual({
        schema_version: 1,
        id: guest.id,
        name: 'fixture',
        type,
      });
      expect(result.omittedDefaults).toContain('cpu');
      expect(result.omittedDefaults).toContain('protection');
      expect(result.omittedDefaults).toContain('extra');
    },
  );

  it('includes VM TPM, agent, EFI and cloud-init values that differ from defaults', () => {
    const guest = parseVmProxmoxConfig('name: fixture\n');
    if (guest.type !== 'vm') throw new Error('fixture type');
    const result = generateDeploymentYaml({
      guest: {
        ...guest,
        protection: false,
        efi_disk: true,
        tpm: true,
        guest_agent: true,
        cloud_init: { user: 'fixture' },
        machine: 'q35',
      },
      defaults: { schema_version: 1, protection: true, tpm: false },
    });
    expect(parse(result.yamlContent)).toMatchObject({
      protection: false,
      tpm: true,
      efi_disk: true,
      guest_agent: true,
      machine: 'q35',
      cloud_init: { user: 'fixture' },
    });
  });

  it.each([
    [null, 1],
    [[1], [1, 2]],
    [[1], { one: 1 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1 }, { a: 2 }],
    [{ a: [1] }, { a: [2] }],
    [undefined, 1],
  ])(
    'keeps distinct extra values rather than omitting them',
    (actual, inherited) => {
      const guest = { ...parseLxcProxmoxConfig(''), extra: { field: actual } };
      const result = generateDeploymentYaml({
        guest,
        defaults: { schema_version: 1, extra: { field: inherited } },
      });
      expect(result.omittedDefaults).not.toContain('extra');
      expect(result.yamlContent).toContain('extra:');
    },
  );

  it('removes internal snapshot/pending metadata and keeps disk options', () => {
    const guest = {
      ...parseLxcProxmoxConfig(''),
      disks: [
        {
          name: 'rootfs',
          storage: 'local',
          size_gb: 8,
          extra: { _pending: {}, _snapshots: {} },
        },
        { name: 'mp1', storage: 'local', size_gb: 10 },
      ],
      extra: { _pending: {}, _snapshots: {} },
    };
    const result = parse(generateDeploymentYaml({ guest }).yamlContent);
    expect(result.disks[0]).toEqual({
      name: 'rootfs',
      storage: 'local',
      size_gb: 8,
    });
    expect(result).not.toHaveProperty('extra');
  });

  it('registers the imported file hash and detects existing paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hacm-import-variants-'));
    try {
      const guest = parseLxcProxmoxConfig('hostname: fixture\n');
      const fs = { ...defaultNodeFileSystem };
      const plan = await planGuestImport({
        dataDir: directory,
        hostId: 'fixture',
        guest,
        fs,
      });
      const guard = new WriteGuard();
      expect(
        await applyGuestImport({ plan, fs, writeGuard: guard }),
      ).toMatchObject({ success: true });
      expect(guard.getHash(plan.fullPath)).toBe(
        await hashContent(await readFile(plan.fullPath, 'utf8')),
      );
      await rm(plan.fullPath);
      await mkdir(plan.fullPath);
      expect(
        (
          await planGuestImport({
            dataDir: directory,
            hostId: 'fixture',
            guest,
            fs,
          })
        ).status,
      ).toBe('new');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
