import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  base: {
    worker: config.worker.id,
    queue: config.worker.queueName,
    env: config.env,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Creates a child logger with correlation_id bound to every line */
export function withCorrelation(correlationId: string) {
  return logger.child({ correlation_id: correlationId });
}
