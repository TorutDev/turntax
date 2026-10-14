/**
 * Repository-relative globs: `*` and `?` match within one path segment, `**` matches any number of
 * segments, and a trailing `/` matches everything in that folder. Patterns match the whole path.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    const segmentStart = i === 0 || g[i - 1] === '/';
    if (c === '*' && g[i + 1] === '*' && segmentStart && (g[i + 2] === '/' || i + 2 === g.length)) {
      // `**/` matches zero or more folders; a final `**` matches the rest of the path.
      re += g[i + 2] === '/' ? '(?:[^/]+/)*' : '.*';
      i += 2;
    } else if (c === '*') {
      while (g[i + 1] === '*') i++;
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A test for paths that match any of the globs. */
export function globMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
