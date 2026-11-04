import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { styleText } from 'node:util';
import { installHints, onPath, servers } from '../precision/lsp-service.ts';
import { choose, confirm } from '../tui.ts';
import { agents } from './agents/index.ts';
import type { Agent, Scope } from './steps.ts';

export { agents } from './agents/index.ts';
export { withTomlTable } from './steps.ts';

/**
 * `csyk setup`: in a terminal with no options, asks which agents and
 * projects to set up and offers to install missing language servers;
 * otherwise prints, or with --write writes, the configuration for the
 * agents named with --agent (Claude Code by default).
 */
export async function setup(args: string[]): Promise<void> {
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) return interactive();
  const named = args.find((a) => a.startsWith('--agent='))?.slice('--agent='.length) ?? (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined);
  const ids = (named ?? 'claude').split(',');
  const unknown = ids.filter((id) => !agents.some((a) => a.id === id));
  if (unknown.length > 0) throw new Error(`Unknown agent ${unknown.join(', ')}; known: ${agents.map((a) => a.id).join(', ')}`);
  const scope: Scope = args.includes('--user') ? 'user' : 'project';
  const chosen = agents.filter((a) => ids.includes(a.id));
  const steps = chosen.flatMap((a) => a.steps(scope, args.includes('--hooks')));
  if (!args.includes('--write')) {
    for (const step of steps) console.log(`${step.target}\n${step.preview}\n`);
    printGaps(chosen);
    console.log(`Run "csyk setup --write ${args.join(' ')}" to write them, or "csyk setup" in a terminal to choose.`);
    return;
  }
  for (const step of steps) step.apply();
  console.log(`Wrote ${steps.map((s) => s.target).join(', ')}.`);
  printGaps(chosen);
  for (const missing of missingServers()) console.log(`For ${missing.language}, install ${missing.name}: ${missing.hint}`);
}

async function interactive(): Promise<void> {
  console.log(`${styleText('bold', 'CSyk setup')}\n`);
  const found = agents.map((a) => a.found());
  const picked = await choose(
    'Which agents should search code with CSyk?',
    agents.map((a, i) => ({ label: a.name, hint: found[i] ? 'installed' : 'not found', checked: found[i] })),
    { multi: true },
  );
  if (picked.length === 0) return console.log('No agent picked; nothing written.');
  const [where] = await choose('For which projects?', [
    { label: 'This project', hint: process.cwd() },
    { label: 'Every project', hint: 'your home folder' },
  ]);
  const scope: Scope = where === 0 ? 'project' : 'user';
  const steps = picked.flatMap((i) => agents[i]?.steps(scope, false) ?? []);
  console.log(`\n${steps.map((s) => `  ${s.target.replace(homedir(), '~')}`).join('\n')}\n`);
  if (!(await confirm('Write these?', true))) return console.log('Nothing written.');
  for (const step of steps) step.apply();
  console.log(styleText('green', `Done: ${picked.map((i) => agents[i]?.name).join(', ')} will use CSyk.\n`));
  printGaps(picked.flatMap((i) => agents[i] ?? []));

  for (const missing of missingServers()) {
    const plan = missing.install;
    if (!plan) {
      console.log(`For ${missing.language}, install ${missing.name}: ${missing.hint}`);
      continue;
    }
    const commands = plan.map((c) => c.join(' ')).join(' && ');
    const relevant = existsSync(missing.marker);
    if (!(await confirm(`${missing.language} needs ${missing.name}, which is not installed. Run "${commands}"?`, relevant))) continue;
    const failed = plan.find((c) => spawnSync(c[0] ?? '', c.slice(1), { stdio: 'inherit' }).status !== 0);
    console.log(failed ? styleText('red', `"${failed.join(' ')}" failed; ${missing.hint}`) : styleText('green', `${missing.name} installed.`));
  }
  console.log('Start your agent in the project; CSyk starts with it.');
}

// What each agent could not be given, so a user knows where it differs from Claude Code.
function printGaps(chosen: Agent[]): void {
  for (const agent of chosen) for (const gap of agent.gaps ?? []) console.log(`${agent.name}: ${gap}`);
}

/** The language servers CSyk cannot start, with how to install each. */
function missingServers(): { name: string; language: string; marker: string; hint: string; install?: string[][] }[] {
  const plans: Record<string, { language: string; marker: string; install?: string[][] }> = {
    gopls: {
      language: 'Go',
      marker: 'go.mod',
      install: onPath('go')
        ? [['go', 'install', 'golang.org/x/tools/gopls@latest']]
        : onPath('brew')
          ? [['brew', 'install', 'gopls']]
          : undefined,
    },
    dart: {
      language: 'Dart',
      marker: 'pubspec.yaml',
      install: onPath('brew') ? [['brew', 'tap', 'dart-lang/dart'], ['brew', 'install', 'dart']] : undefined,
    },
  };
  return servers.flatMap((s) => {
    const plan = plans[s.name];
    return plan && !s.command() ? [{ name: s.name, hint: installHints[s.name] ?? '', ...plan }] : [];
  });
}
