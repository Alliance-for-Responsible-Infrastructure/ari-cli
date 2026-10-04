import fs from 'fs';
import os from 'os';
import path from 'path';

import requireJSON from '#src/lib/require-json.js';

/**
 * Local, per-machine config holding the org-specific AWS details that are
 * deliberately NOT shipped in the (public) repo: the SSO start URL, SSO
 * region, and each account's AWS account ID. Populated by `ari init`.
 */
export function getLocalConfigPath() {
    return path.join(os.homedir(), '.ari', 'config.json');
}

/**
 * @returns {Object|null} the parsed local config, or null if it hasn't been
 * created yet (i.e. the user hasn't run `ari init`).
 */
export function readLocalConfig() {
    const configPath = getLocalConfigPath();
    if (!fs.existsSync(configPath)) {
        return null;
    }
    return requireJSON(configPath);
}

/**
 * Writes the local config, creating ~/.ari if needed and restricting the
 * file to owner read/write (it holds org-identifying AWS details).
 * @param {Object} data
 */
export function writeLocalConfig(data) {
    const configPath = getLocalConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 4), {
        mode: 0o600,
    });
    fs.chmodSync(configPath, 0o600);
}
