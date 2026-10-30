// Which Go files the default `go build` on this machine leaves out, as gopls
// does: a name ending in another system or architecture (`_windows.go`,
// `_linux_arm64.go`), or a `//go:build` line this machine does not meet.

const systems = new Set(
  'aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows zos'.split(' '),
);
const architectures = new Set(
  ('386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64 mips64le mips64p32 mips64p32le ' +
    'ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm').split(' '),
);
const unix = new Set('aix android darwin dragonfly freebsd hurd illumos ios linux netbsd openbsd solaris'.split(' '));

// Node's names for this machine, in Go's words.
const goos = ({ win32: 'windows', sunos: 'solaris' } as Record<string, string>)[process.platform] ?? process.platform;
const goarch = ({ x64: 'amd64', ia32: '386', ppc64: 'ppc64le', mipsel: 'mipsle' } as Record<string, string>)[process.arch] ?? process.arch;

// The tags a default build sets: the system, the
// architecture, `unix`, the gc compiler with cgo, and every Go release.
function isSet(tag: string): boolean {
  if (tag === goos || tag === goarch || tag === 'gc' || tag === 'cgo') return true;
  if (tag === 'unix') return unix.has(goos);
  // Android builds Linux files too.
  if (tag === 'linux' && goos === 'android') return true;
  return /^go1\.\d+$/.test(tag);
}

/** Whether the default build on this machine leaves out the Go [file], whose source is [text]. */
export function leftOutOfBuild(file: string, text: string): boolean {
  // As go/build reads a name: what follows its first `_`, less `_test`.
  const name = (file.split('/').pop() ?? '').split('.')[0] ?? '';
  const parts = name.includes('_') ? name.slice(name.indexOf('_')).split('_') : [];
  if (parts.at(-1) === 'test') parts.pop();
  const [system, arch] = [parts.at(-2) ?? '', parts.at(-1) ?? ''];
  if (systems.has(system) && architectures.has(arch)) {
    if (!isSet(system) || !isSet(arch)) return true;
  } else if ((systems.has(arch) || architectures.has(arch)) && !isSet(arch)) return true;
  // The constraint comes before the package clause.
  const header = text.slice(0, Math.max(text.search(/^package\s/m), 0));
  const constraint = /^\/\/go:build\s+(.+)$/m.exec(header)?.[1];
  return constraint !== undefined && !holds(constraint);
}

// Evaluates a build expression: tags joined by `!`, `&&`, `||` and parentheses.
function holds(expression: string): boolean {
  const tokens = expression.match(/!|&&|\|\||\(|\)|[\w.]+/g) ?? [];
  let at = 0;
  const any = (): boolean => {
    let value = all();
    while (tokens[at] === '||') {
      at++;
      value = all() || value;
    }
    return value;
  };
  const all = (): boolean => {
    let value = one();
    while (tokens[at] === '&&') {
      at++;
      value = one() && value;
    }
    return value;
  };
  const one = (): boolean => {
    const token = tokens[at++];
    if (token === '!') return !one();
    if (token === '(') {
      const value = any();
      at++;
      return value;
    }
    return token !== undefined && isSet(token);
  };
  return any();
}
