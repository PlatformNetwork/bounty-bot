import type { ChatCompletionChunk } from "openai/resources/index.js";

export interface AssembledToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssembledMessage {
  content: string | null;
  tool_calls: AssembledToolCall[];
}

export interface AssembledCompletion {
  message: AssembledMessage;
}

/**
 * Consume an OpenAI streaming response and assemble the full message
 * including content and tool calls. This keeps the connection alive
 * (avoids timeouts on long-running LLM responses via OpenRouter).
 */
export async function collectStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): Promise<AssembledCompletion> {
  let content = "";
  const toolCallMap: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) content += delta.content;

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallMap[tc.index]) {
          toolCallMap[tc.index] = { id: "", name: "", arguments: "" };
        }
        const entry = toolCallMap[tc.index];
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }
  }

  const tool_calls: AssembledToolCall[] = Object.keys(toolCallMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((idx) => {
      const tc = toolCallMap[Number(idx)];
      return {
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      };
    });

  // Some models via OpenRouter return tool call data as content text
  // when streaming. Try to extract it as a fallback.
  if (tool_calls.length === 0 && content) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.verdict || parsed.plausible !== undefined) {
          tool_calls.push({
            id: "fallback_tool_call",
            type: "function",
            function: {
              name: parsed.verdict !== undefined
                ? "deliver_verdict"
                : "deliver_code_verdict",
              arguments: jsonMatch[0],
            },
          });
        }
      } catch {
        // Not valid JSON, ignore
      }
    }
  }

  return {
    message: {
      content: content || null,
      tool_calls,
    },
  };
}
