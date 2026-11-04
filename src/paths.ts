import { relative, sep } from 'node:path';

/**
 * [path] with forward slashes. Every path CSyk keeps or answers with is
 * repo-relative and written this way, on Windows too, where Node and
 * ripgrep give backslashes: ids such as src/cart/total.ts#Cart.total must
 * read the same whatever wrote them.
 */
export const toPosix = (path: string): string => (sep === '\\' ? path.replaceAll('\\', '/') : path);

/** [path] relative to [root], with forward slashes. */
export const repoRelative = (root: string, path: string): string => toPosix(relative(root, path));
