const getFunctionName = (fn) => {
    return fn.name || 'anonymous fn';
};

const getFunctionConstructorName = (fn) => {
    return fn?.constructor.name ? ` ${fn?.constructor.name}` : '';
};

export const getFormattedCommands = (commands) => {
    return commands.map(
        (c) => `${getFunctionName(c)}${getFunctionConstructorName(c)}`,
    );
};
