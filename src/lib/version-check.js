import * as path from 'path';
import * as url from 'url';
import * as semver from 'semver';

import { styles } from '#src/lib/cli/terminal.js';
import requireJSON from '#src/lib/require-json.js';
import isLocal from '#src/lib/is-local.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkg = requireJSON(path.join(__dirname, '../../package.json'));
const { warn, bold, emphasis } = styles;

const PACKAGE_JSON_URL =
    'https://raw.githubusercontent.com/Alliance-for-Responsible-Infrastructure/ari-cli/main/package.json';

/**
 * Prints the running version and, best-effort, warns if a newer version is
 * available. Never throws — a network hiccup or an as-yet-unpublished repo
 * should never block a command from running.
 */
export default async () => {
    const localStr = isLocal() ? ' (local)' : '';
    console.log(bold(`\nRunning ari-cli v${pkg.version}${localStr}\n`));

    try {
        const res = await fetch(PACKAGE_JSON_URL);
        if (!res.ok) return;
        const curPkg = await res.json();

        if (semver.gt(curPkg.version, pkg.version)) {
            console.log(
                warn('warning:'),
                bold(`v${curPkg.version}`),
                'of the ari-cli is available.\n',
            );
            console.log(
                emphasis('recommendation:'),
                'execute',
                bold(
                    'npm i -g github:Alliance-for-Responsible-Infrastructure/ari-cli',
                ),
                'to get the latest version of the ari-cli.\n',
            );
        }
    } catch {
        /* die silently if the above fails — never block a command on this */
    }
};
