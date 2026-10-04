import * as url from 'url';
import path from 'path';

import requireJSON from '#src/lib/require-json.js';
import { readLocalConfig } from '#src/lib/local-config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ARI_CONFIG = requireJSON(path.join(__dirname, '../../ari-config.json'));

/**
 * Base class for all ARI commands
 */
export default class BaseAriEntity {
    constructor(options) {
        // Shipped with the repo — safe to be public (account keys/names,
        // roles). No org-identifying AWS details live here.
        this.ariConfig = ARI_CONFIG;
        // Per-machine, created by `ari init` — holds the SSO start URL,
        // region, and account IDs. null until `ari init` has been run.
        this.localConfig = readLocalConfig();
        this.cwd = process.cwd();
        this.options = options;
    }

    /**
     * Merges the shipped account registry (name) with the local account ID
     * for a given account key.
     * @param {string} accountKey
     * @returns {{name: string, accountId: string}|null} null if the account
     * key is unknown, or the local config doesn't have an ID for it yet.
     */
    getAccountConfig(accountKey) {
        const shipped = this.ariConfig.credentials.accounts[accountKey];
        if (!shipped) return null;

        const accountId = this.localConfig?.accounts?.[accountKey]?.accountId;
        if (!accountId) return null;

        return { name: shipped.name, accountId };
    }
}
