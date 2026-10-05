import { z } from 'zod';
import { MAX_MESSAGE_CHARS, MAX_MESSAGES } from '../../domain/limits.js';

/**
 * FR1/FR3 request schema. OpenAI-compatible in shape, but only `messages` is honoured: every other
 * field (model, max_tokens, temperature, stream, tools, …) is stripped and ignored (SPEC §3).
 * Body size (≤ 256 KB) is enforced earlier by Fastify's bodyLimit.
 *
 * `system` is accepted so standard clients don't break, then dropped by the message policy.
 * Other roles (tool, function, developer) and non-string content (content parts) are rejected.
 */
export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CHARS),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES),
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;
