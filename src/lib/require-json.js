import * as fs from 'fs';

/**
 * Reads a JSON file and returns the parsed JSON object
 * @param {string} filePath - the path to the JSON file
 * (used to prevent warnings from ESLint when importing json files directly)
 * @returns the parsed JSON object
 */
export default (filePath) => {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};
