import { ValidationError } from '../domain/errors.js';
import type { ChatMessage } from '../domain/types.js';

/**
 * Trust boundary for message content (SPEC §3): the client controls only the conversation.
 * - Client `system` messages are dropped, so a student can't override the gateway's instructions.
 * - The configured system prompt is always first.
 * - At least one user/assistant message must remain.
 */
export function buildProviderMessages(
  clientMessages: readonly ChatMessage[],
  systemPrompt: string,
): ChatMessage[] {
  const conversation = clientMessages.filter((m) => m.role !== 'system');
  if (conversation.length === 0) {
    throw new ValidationError('no user/assistant messages after dropping system messages');
  }
  return [{ role: 'system', content: systemPrompt }, ...conversation];
}
