// Structured logging for the TabDesk main process.
//
// A tiny dependency-free logger that emits one JSON object per line through the
// console, so output stays machine-parseable for grep/journalctl/structured
// collectors while remaining readable in a terminal. Every record carries a
// timestamp, level, the emitting component, the message, and any extra context
// fields the call site passed — replacing the ad-hoc `console.warn('[tag]…')`
// calls that were scattered across modules.
//
// Levels are filtered through TABDESK_LOG_LEVEL (error|warn|info|debug),
// defaulting to `info` so the noisy debug paths stay quiet unless asked for.
// The sinks are console.error/warn/log so existing tests that intercept
// console.warn keep capturing warn records.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  const env = String(process.env.TABDESK_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[env] != null ? LEVELS[env] : LEVELS.info;
}

// Errors don't JSON-serialize (stack/message are non-enumerable), so pull the
// useful bits out and keep the stack for diagnostics. Nested objects are
// walked so a context like { error: err, port: 7000 } serializes cleanly.
function clean(value) {
  if (value instanceof Error) {
    const out = { message: value.message };
    if (value.stack) out.stack = value.stack;
    if (value.code) out.code = value.code;
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v);
    return out;
  }
  return value;
}

function sinkFor(level) {
  if (level === 'error') return console.error;
  if (level === 'warn') return console.warn;
  return console.log;
}

// Create a logger scoped to `component`. Each method takes a message and an
// optional context object whose own keys are merged into the record, so a call
// like `log.warn('could not persist', { error: err })` produces
// {"ts":...,"level":"warn","component":"settings","msg":"could not persist","error":{...}}.
function createLogger(component) {
  function write(level, msg, context) {
    if (LEVELS[level] > currentLevel()) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      component: String(component || 'app'),
      msg: String(msg),
    };
    if (context && typeof context === 'object') {
      for (const [k, v] of Object.entries(context)) record[k] = clean(v);
    } else if (context !== undefined) {
      record.context = clean(context);
    }
    sinkFor(level)(JSON.stringify(record));
  }
  return {
    error: (msg, ctx) => write('error', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    debug: (msg, ctx) => write('debug', msg, ctx),
  };
}

const logger = createLogger('app');

module.exports = createLogger;
module.exports.logger = logger;
module.exports.createLogger = createLogger;
