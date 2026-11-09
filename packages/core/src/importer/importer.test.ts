import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProxmoxConfig, serialiseProxmoxConfig } from '../codec/index.js';
import {
  deploymentDefaultsFileSchema,
  guestDeploymentFileSchema,
} from '../schema/deployment.js';
import { mergeGuestDeployment } from '../merge/guest-merge.js';
import { loadYamlDocument } from '../yaml/document.js';
import { generateDeploymentYaml } from './generate.js';
import { planGuestImport } from './plan.js';
import { applyGuestImport } from './apply.js';

const fixturesDir = join(__dirname, '../../fixtures/proxmox');

describe('Guest Importer', () => {
  it('imports fixture LXC guest, omits default-matching values, and re-diffs with zero drift', () => {
    const rawConf = readFileSync(
      join(fixturesDir, 'lxc-112-unprivileged.conf'),
      'utf8',
    );
    const liveGuest = parseProxmoxConfig(rawConf, 'lxc', 112);

    // Default deployment with same CPU and RAM
    const defaults = deploymentDefaultsFileSchema.parse({
      schema_version: 1,
      cpu: 2,
      ram: 1024,
      protection: true,
    });

    const { yamlContent, omittedDefaults } = generateDeploymentYaml({
      guest: liveGuest,
      defaults,
    });

    // Verify omission of defaults
    expect(omittedDefaults).toContain('cpu');
    expect(omittedDefaults).toContain('ram');
    expect(yamlContent).not.toMatch(/^cpu:/m);
    expect(yamlContent).not.toMatch(/^ram:/m);

    // Verify it parses against guestDeploymentFileSchema
    const doc = loadYamlDocument(yamlContent);
    const parsedFile = guestDeploymentFileSchema.parse(doc.toJSON());
    expect(parsedFile.id).toBe(112);
    expect(parsedFile.name).toBe('example-lxc');
    expect(parsedFile.type).toBe('lxc');

    // Merge with defaults
    const merged = mergeGuestDeployment({
      defaultDeployment: { file: 'default-deployment.yaml', data: defaults },
      guestDeployment: { file: 'deployment.yaml', data: parsedFile },
    }).deployment;
    expect(merged.cpu).toBe(2);
    expect(merged.ram).toBe(1024);

    // Zero-drift test: serialising merged back to Proxmox config gives same result
    const serialisedLive = serialiseProxmoxConfig(liveGuest);
    const serialisedMerged = serialiseProxmoxConfig(merged);
    expect(serialisedMerged).toBe(serialisedLive);
  });

  it('imports fixture VM guest with cloud-init and EFI, validating schema and re-diffing', () => {
    const rawConf = readFileSync(
      join(fixturesDir, 'vm-212-cloudinit-efi.conf'),
      'utf8',
    );
    const liveGuest = parseProxmoxConfig(rawConf, 'vm', 212);

    const { yamlContent } = generateDeploymentYaml({
      guest: liveGuest,
    });

    const doc = loadYamlDocument(yamlContent);
    const parsedFile = guestDeploymentFileSchema.parse(doc.toJSON());
    expect(parsedFile.id).toBe(212);
    expect(parsedFile.name).toBe('example-vm');
    expect(parsedFile.type).toBe('vm');

    // Zero-drift test
    const merged = mergeGuestDeployment({
      guestDeployment: { file: 'deployment.yaml', data: parsedFile },
    }).deployment;
    const serialisedLive = serialiseProxmoxConfig(liveGuest);
    const serialisedMerged = serialiseProxmoxConfig(merged);
    expect(serialisedMerged).toBe(serialisedLive);
  });

  it('re-running import does not overwrite existing files without explicit overwrite flag', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hacm-import-test-'));
    try {
      const rawConf = readFileSync(
        join(fixturesDir, 'lxc-112-unprivileged.conf'),
        'utf8',
      );
      const liveGuest = parseProxmoxConfig(rawConf, 'lxc', 112);

      // 1. Initial plan & apply
      const plan1 = await planGuestImport({
        dataDir: tempDir,
        hostId: 'pve-01',
        guest: liveGuest,
      });
      expect(plan1.status).toBe('new');

      const applyRes1 = await applyGuestImport({ plan: plan1 });
      expect(applyRes1.success).toBe(true);

      const writtenContent = await readFile(plan1.fullPath, 'utf8');
      expect(writtenContent).toContain('name: example-lxc');

      // 2. Re-running plan detects already_exists
      const plan2 = await planGuestImport({
        dataDir: tempDir,
        hostId: 'pve-01',
        guest: liveGuest,
      });
      expect(plan2.status).toBe('already_exists');

      // 3. Re-running apply refuses overwrite
      const applyRes2 = await applyGuestImport({ plan: plan2 });
      expect(applyRes2.success).toBe(false);
      expect(applyRes2.reason).toBe('already_exists');

      // 4. Overwrite allowed with explicit overwrite: true
      const applyRes3 = await applyGuestImport({
        plan: plan2,
        overwrite: true,
      });
      expect(applyRes3.success).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
