import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const variant = process.argv[2];
assert.ok(['slim', 'ffmpeg'].includes(variant));
assert.equal(process.getuid(), 1000);
assert.equal(process.cwd(), '/app');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.16.0');
assert.equal(process.report.getReport().header.glibcVersionRuntime, '2.36');
assert.equal(process.env.PNPM_HOME, '/tmp/.pnpm');
assert.equal(process.env.PM2_HOME, '/tmp/.pm2');
assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), '10.33.0');
if (variant === 'ffmpeg') {
  const lock = JSON.parse(await readFile('/checks/node-24/ffmpeg.lock.json', 'utf8'));
  assert.equal(process.env.FFMPEG_BIN, '/usr/local/bin/ffmpeg');
  assert.equal(process.env.FFMPEG_BINARY_SHA256, lock.binarySha256);
  const binary = await readFile(process.env.FFMPEG_BIN);
  assert.equal(createHash('sha256').update(binary).digest('hex'), lock.binarySha256);
  const version = execFileSync(process.env.FFMPEG_BIN, ['-version'], { encoding: 'utf8' });
  assert.ok(version.startsWith(`ffmpeg version ${lock.version}-static `));
  for (const [codec, format] of [['libmp3lame', 'mp3'], ['libopus', 'opus']]) {
    const encoded = execFileSync(process.env.FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.1',
      '-c:a', codec, '-f', format, 'pipe:1',
    ]);
    assert.ok(encoded.length > 0, `${format} encoding failed`);
  }
  console.log(version.split('\n')[0]);
}
console.log(`${variant}: non-root runtime, pnpm and offline checks passed`);
