import type { Agent } from '../steps.ts';
import { antigravity } from './antigravity.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { hermes } from './hermes.ts';
import { opencode } from './opencode.ts';

/** Every agent setup knows, one file each: what differs is where each keeps its configuration. */
export const agents: Agent[] = [claude, codex, antigravity, cursor, opencode, hermes];
