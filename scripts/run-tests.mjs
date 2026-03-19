import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-home-'));
const testDir = path.join(process.cwd(), 'src', '__tests__');
const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join('src', '__tests__', file));

const result = spawnSync(
  process.execPath,
  ['--test', '--import', 'tsx', '--test-timeout=15000', ...testFiles],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CTI_HOME: tempDir,
    },
  },
);

fs.rmSync(tempDir, { recursive: true, force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
