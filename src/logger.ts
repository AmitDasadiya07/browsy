type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogListener = (level: LogLevel, message: string, timestamp: string) => void;

const listeners = new Set<LogListener>();

function emit(level: LogLevel, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  for (const listener of listeners) {
    try {
      listener(level, message, timestamp);
    } catch {
      // ignore listener failures
    }
  }
}

export const logger = {
  on(listener: LogListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  debug(message: string): void {
    emit('debug', message);
  },
  info(message: string): void {
    emit('info', message);
  },
  warn(message: string): void {
    emit('warn', message);
  },
  error(message: string): void {
    emit('error', message);
  },
};
