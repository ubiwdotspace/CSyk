import { emitKeypressEvents } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { styleText } from 'node:util';

export type Choice = { label: string; hint?: string; checked?: boolean };
type Input = Readable & { setRawMode?: (raw: boolean) => void };
export type Io = { input?: Input; output?: Writable };

/**
 * Asks to pick among [choices] in the terminal: arrows move, space ticks
 * (with [multi]), enter confirms. Resolves to the indexes picked; with one
 * choice allowed, the one under the cursor, which starts at [start].
 */
export function choose(title: string, choices: Choice[], { multi = false, start = 0, io = {} as Io } = {}): Promise<number[]> {
  const input = io.input ?? (process.stdin as Input);
  const output = io.output ?? process.stdout;
  const ticked = choices.map((c) => c.checked ?? false);
  let at = start;
  let drawn = 0;
  const help = multi ? 'arrows move, space ticks, enter confirms' : 'arrows move, enter confirms';
  const draw = () => {
    const lines = [
      `${styleText('bold', title)} ${styleText('dim', `(${help})`)}`,
      ...choices.map((c, i) => {
        const mark = multi ? (ticked[i] ? '[x]' : '[ ]') : i === at ? '(•)' : '( )';
        const line = `${i === at ? '›' : ' '} ${mark} ${c.label}${c.hint ? `  ${styleText('dim', c.hint)}` : ''}`;
        return i === at ? styleText('cyan', line) : line;
      }),
    ];
    output.write(`${drawn ? `\x1b[${drawn}A\x1b[J` : ''}${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((done) => {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    const onKey = (_: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.ctrl && key.name === 'c') {
        input.setRawMode?.(false);
        output.write('\n');
        process.exit(130);
      }
      if (key.name === 'up') at = (at + choices.length - 1) % choices.length;
      else if (key.name === 'down') at = (at + 1) % choices.length;
      else if (key.name === 'space' && multi) ticked[at] = !ticked[at];
      else if (key.name === 'return') {
        input.off('keypress', onKey);
        input.setRawMode?.(false);
        input.pause();
        done(multi ? ticked.flatMap((t, i) => (t ? [i] : [])) : [at]);
        return;
      }
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}

/** A yes or no question; enter alone answers [yes]. */
export async function confirm(question: string, yes: boolean, io: Io = {}): Promise<boolean> {
  const [picked] = await choose(question, [{ label: 'Yes' }, { label: 'No' }], { start: yes ? 0 : 1, io });
  return picked === 0;
}
