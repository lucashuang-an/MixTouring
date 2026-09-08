/* wishlist-store.mjs · 心愿单读写：与 generate-plan 解耦，前端不需要它 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(root, 'data/wishlist.json');

export function getWishlist(file = DEFAULT_FILE) {
  if (!existsSync(file)) return { items: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveWishlist(items, file = DEFAULT_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ items }, null, 2) + '\n', 'utf8');
}
