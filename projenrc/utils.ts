import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function copySync(from: string, to: string) {
  const stat = statSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      copySync(join(from, file), join(to, file));
    }
  } else if (stat.isFile()) {
    copyFileSync(from, to);
  } else {
    console.warn('Not copying non-file/directory object:', from);
  }
}
