import pc from 'picocolors';

/**
 * Small, dependency-light replacement for hero-cli's
 * @nrel-design-system/terminal `createTheme()` — same shape (the style
 * names callers use), no internal/private package required.
 */
export const styles = {
    success: (s) => pc.green(s),
    error: (s) => pc.red(s),
    warn: (s) => pc.yellow(s),
    emphasis: (s) => pc.cyan(s),
    bold: (s) => pc.bold(s),
};
