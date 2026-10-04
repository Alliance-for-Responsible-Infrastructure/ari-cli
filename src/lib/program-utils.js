import { Command, Option } from 'commander';
import * as path from 'path';
import * as url from 'url';

import requireJSON from '#src/lib/require-json.js';
import isLocal from '#src/lib/is-local.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkg = requireJSON(path.join(__dirname, '../..', './package.json'));

const localStr = isLocal() ? ' (local)' : '';

export const rawVersionString = pkg.version;

/**
 * Version string for the CLI, includes local flag if applicable
 * @type {string}
 */
export const versionString = pkg.version + localStr;

/**
 * Custom arg parser that converts a comma-separated string into an array
 * @param {string} value
 */
export function commaSeparatedList(value) {
    return value.split(',');
}

/**
 * Adds options to a command
 * @param {Command} command
 * @param {Option[]} options
 * @returns {Command}
 */
export function addOptions(command, options) {
    options.forEach((opt) => command.addOption(opt));
    return command;
}
