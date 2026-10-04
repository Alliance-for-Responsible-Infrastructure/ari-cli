import globals from 'globals';
import pluginJs from '@eslint/js';

export default [
    {
        ...pluginJs.configs.recommended,
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            ...pluginJs.configs.recommended.rules,
            'no-unused-vars': 'off',
        },
    },
];
