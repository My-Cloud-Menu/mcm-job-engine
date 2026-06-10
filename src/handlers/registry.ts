import { Handler } from '../core/types';

// Registry maps "integration.step_name" → handler function
const registry = new Map<string, Handler>();

export function registerHandler(
  integration: string,
  stepName: string,
  handler: Handler
): void {
  registry.set(`${integration}.${stepName}`, handler);
}

export function getHandler(integration: string, stepName: string): Handler | undefined {
  return registry.get(`${integration}.${stepName}`);
}
