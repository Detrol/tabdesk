const SENSITIVE_KEY = /(authorization|cookie|credential|key|password|secret|token)/i;

function safeValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, childValue]) => [childKey, safeValue(childValue, childKey)]));
  }
  return value;
}

function emit(level, scope, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    event,
    ...safeValue(fields),
  };
  const output = JSON.stringify(record);
  const write = console[level] || console.log;
  write(output);
}

function createLogger(scope) {
  return {
    debug: (event, fields) => emit('debug', scope, event, fields),
    info: (event, fields) => emit('info', scope, event, fields),
    warn: (event, fields) => emit('warn', scope, event, fields),
    error: (event, fields) => emit('error', scope, event, fields),
  };
}

module.exports = { createLogger, emit, safeValue };
