// Local-only executable fixture. Never reads credentials or contacts a host.
import process from 'node:process';
import { setTimeout } from 'node:timers';

switch (process.argv[2]) {
  case 'value':
    process.stdout.write('fixture-secret\n');
    break;
  case 'env':
    process.stdout.write(process.env.HACM_TEST_VALUE ?? 'missing');
    break;
  case 'failure':
    process.stderr.write('fixture command failed');
    process.exitCode = 7;
    break;
  case 'large':
    process.stdout.write('x'.repeat(100_000));
    break;
  case 'wait':
    setTimeout(() => process.stdout.write('too late'), 30_000);
    break;
}
