
// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',

  fgBlack: '\x1b[30m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgMagenta: '\x1b[35m',
  fgCyan: '\x1b[36m',
  fgWhite: '\x1b[37m',

  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

type LogLevel = 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export function createLogger(prefix: string) {
  function log(level: LogLevel, message: string, metadata?: Record<string, unknown>) {
    const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
    let colorStart = '';
    let colorEnd = COLORS.reset;
    let bgColor = '';

    switch (level) {
      case 'DEBUG':
        colorStart = COLORS.fgCyan;
        break;
      case 'INFO':
        colorStart = COLORS.fgBlue;
        break;
      case 'SUCCESS':
        colorStart = COLORS.fgGreen;
        bgColor = COLORS.bgBlack;
        break;
      case 'WARN':
        colorStart = COLORS.fgYellow;
        break;
      case 'ERROR':
        colorStart = COLORS.fgRed;
        bgColor = COLORS.bgBlack;
        break;
    }

    const levelStr = bgColor ? `${bgColor}${colorStart}[${level}]${colorEnd}` : `${colorStart}[${level}]${colorEnd}`;
    let logMsg = `[${timestamp}] ${COLORS.fgMagenta}[${prefix}]${COLORS.reset} ${levelStr} ${message}`;
    
    if (metadata) {
      logMsg += ` ${COLORS.dim}(${JSON.stringify(metadata)})${COLORS.reset}`;
    }

    console.log(logMsg);
  }

  return {
    debug: (msg: string, metadata?: Record<string, unknown>) => log('DEBUG', msg, metadata),
    info: (msg: string, metadata?: Record<string, unknown>) => log('INFO', msg, metadata),
    success: (msg: string, metadata?: Record<string, unknown>) => log('SUCCESS', msg, metadata),
    warn: (msg: string, metadata?: Record<string, unknown>) => log('WARN', msg, metadata),
    error: (msg: string, metadata?: Record<string, unknown>) => log('ERROR', msg, metadata),
  };
}
