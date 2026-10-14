import { createInterface } from 'readline/promises';

/** True when both stdin and stdout are a terminal (safe to prompt). */
export function isInteractive() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Asks a y/N question on the terminal. Anything but y/yes is "no".
 * Prompt text goes to stderr so stdout stays clean for piping.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export async function confirm(question) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
