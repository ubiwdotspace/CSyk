import { describe, expect, it } from 'vitest';
import { leftOutOfBuild } from './go-build.ts';

const go = (constraint: string) => `${constraint}\n\npackage x\n`;

describe('leftOutOfBuild', () => {
  it('reads a //go:build line before the package clause', () => {
    expect(leftOutOfBuild('a.go', go('//go:build ignore'))).toBe(true);
    expect(leftOutOfBuild('a.go', go('//go:build !ignore && go1.21'))).toBe(false);
    expect(leftOutOfBuild('a.go', go('//go:build (ignore || unix || windows) && !plan9'))).toBe(false);
    expect(leftOutOfBuild('a.go', 'package x\n\n//go:build ignore\n')).toBe(false);
  });

  it('reads a system or architecture at the end of the name', () => {
    expect(leftOutOfBuild('fs/stat_plan9.go', go(''))).toBe(true);
    expect(leftOutOfBuild('fs/stat_plan9_amd64_test.go', go(''))).toBe(true);
    expect(leftOutOfBuild('fs/stat_mips64p32le.go', go(''))).toBe(true);
    // What comes before the first underscore is not read.
    expect(leftOutOfBuild('fs/plan9.go', go(''))).toBe(false);
    expect(leftOutOfBuild('fs/labels_stringlabels.go', go(''))).toBe(false);
  });
});
