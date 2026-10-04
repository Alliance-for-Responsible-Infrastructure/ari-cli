import path from 'path';
import * as url from 'url';

import { styles } from '#src/lib/cli/terminal.js';
import requireJSON from '#src/lib/require-json.js';
import CredentialsCommand, {
    printAccountsList,
} from '#src/classes/credentials.js';

const { error } = styles;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ariConfig = requireJSON(path.join(__dirname, '../../ari-config.json'));

/**
 * Authenticate with an ARI AWS account via SSO and activate credentials,
 * abstracting away account IDs and SSO configuration details.
 *
 * @param {Object} options - CLI options
 * @param {string} [options.account] - "management" | "controlled" | "public"
 * @param {string} options.role      - IAM role name (defaults to config's defaultRole)
 * @param {boolean} options.list     - list accounts/roles and exit
 * @param {boolean} options.print    - print raw export statements to stdout
 * @param {boolean} options.force    - force a fresh SSO login
 */
export default async (options) => {
    if (options.list) {
        printAccountsList(ariConfig);
        process.exit(0);
    }

    if (!options.account) {
        console.error(
            error('Error:'),
            'Missing required --account. Run "ari credentials --list" to see available accounts.',
        );
        process.exit(1);
    }

    const cmd = new CredentialsCommand(options);
    await cmd.execute();
    process.exit(0);
};
