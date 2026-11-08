import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout } from 'node:timers/promises';

const [lockPath, outputDir] = process.argv.slice(2);
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
assert.equal(process.platform, lock.platform);
assert.equal(process.arch, lock.arch);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
await mkdir(outputDir, { recursive: true });
for (const [name, expected] of Object.entries(lock.files)) {
  let bytes;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${lock.baseUrl}/${name}`, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${name}`);
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      console.error(`FFmpeg download retry ${attempt + 1}: ${error.message}`);
      await setTimeout(2000 * 2 ** attempt);
    }
  }
  assert.equal(sha256(bytes), expected, `Checksum mismatch: ${name}`);
  if (name.endsWith('.gz')) {
    const binary = gunzipSync(bytes);
    assert.equal(sha256(binary), lock.binarySha256, 'FFmpeg binary checksum mismatch');
    await writeFile(join(outputDir, 'ffmpeg'), binary, { mode: 0o555 });
  } else {
    await writeFile(join(outputDir, name.endsWith('.LICENSE') ? 'LICENSE' : 'README'), bytes);
  }
}
console.log(`Verified FFmpeg ${lock.version} (${lock.binarySha256})`);
