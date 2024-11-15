import readline from 'node:readline';
import { disconnectAll } from './db';

export const DRY_RUN_PREFIX = 'DRY RUN: ';
export function prefix(dryRun: boolean): string {
  return dryRun ? DRY_RUN_PREFIX : '';
}

let terminal: readline.Interface;

function initTerminal(): void {
  if (!terminal) {
    terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
}

export function closeTerminal(): void {
  if (terminal) {
    terminal.close();
  }
}

export function shutdown(): void {
  disconnectAll().catch(console.error);
  closeTerminal();
}

function ask(text: string, defaultValue: string | number = ''): Promise<string> {
  initTerminal();
  return new Promise((resolve) => {
    terminal.question(text + (defaultValue ? ' (' + defaultValue + ')' : '') + ' ', (answer: string) => {
      resolve(answer || defaultValue.toString());
    });
  });
}
/**
 * Prints a question and waits for user to choose one of the provided options.
 * @param text - The prompt text to print.
 * @param options - The list of options that the user can select.
 * @param defaultValue - Optional default value.
 * @returns The selected value, or default value on empty selection.
 */
async function choose(text: string, options: (string | number)[], defaultValue = ''): Promise<string> {
  const str = text + ' [' + options.map((o) => (o === defaultValue ? '(' + o + ')' : o)).join('|') + ']';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await ask(str)) || defaultValue;
    if (options.includes(answer)) {
      return answer;
    }
    print('Please choose one of the following options: ' + options.join(', '));
  }
}
/**
 * Prints to stdout.
 * @param text - The text to print.
 */
function print(text: string): void {
  terminal.write(text + '\n');
}

/**
 * Prints a question and waits for the user to choose yes or no.
 * @param text - The question to print.
 * @returns true on accept or false on reject.
 */
export async function yesOrNo(text: string): Promise<boolean> {
  return (await choose(text, ['y', 'n'])).toLowerCase() === 'y';
}
