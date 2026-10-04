import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export default () => {
    let npmLink = false;
    let yarnLink = false;

    try {
        const output = execSync('npm ls --link --global', {
            stdio: 'pipe',
        }).toString();

        npmLink = output.includes('ari-cli');

        const yarnLinkPath = path.join(
            os.homedir(),
            '.config/yarn/link/ari-cli',
        );
        yarnLink = fs.existsSync(yarnLinkPath);
    } catch {
        // Silent fail
    }

    return npmLink || yarnLink;
};
