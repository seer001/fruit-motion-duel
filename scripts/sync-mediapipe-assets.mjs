import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(projectRoot, 'public', 'vendor', 'mediapipe');

await mkdir(target, { recursive: true });
for (const file of await readdir(source)) {
  if (file.endsWith('.wasm') || file.endsWith('.js')) {
    await cp(join(source, file), join(target, file));
  }
}

console.log('MediaPipe WASM 資產已同步至 public/vendor/mediapipe。');

