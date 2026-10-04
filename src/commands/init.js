import InitCommand from '#src/classes/init.js';

/**
 * Collects the org-specific AWS details (SSO start URL, region, account
 * IDs) and saves them to ~/.ari/config.json.
 *
 * @param {Object} options - CLI options
 * @param {string} [options.fromFile] - path to a config a teammate shared
 * @param {boolean} [options.force] - skip the overwrite confirmation
 */
export default async (options) => {
    const cmd = new InitCommand(options);
    await cmd.run();
    process.exit(0);
};
