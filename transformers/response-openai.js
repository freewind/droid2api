import { logDebug } from '../logger.js';

export class OpenAIResponseTransformer {
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.hasToolCalls = false;
    this.toolCallCount = 0;
    // Responses output item id -> OpenAI tool_calls index
    this.itemToToolIndex = new Map();
  }

  parseSSELine(line) {
    if (line.startsWith('event:')) {
      return { type: 'event', value: line.slice(6).trim() };
    }
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      try {
        return { type: 'data', value: JSON.parse(dataStr) };
      } catch (e) {
        return { type: 'data', value: dataStr };
      }
    }
    return null;
  }

  transformEvent(eventType, eventData) {
    logDebug(`Target OpenAI event: ${eventType}`);

    if (eventType === 'response.created') {
      return this.createOpenAIChunk('', 'assistant', false);
    }

    if (eventType === 'response.in_progress') {
      return null;
    }

    if (eventType === 'response.output_text.delta') {
      const text = eventData.delta || eventData.text || '';
      return this.createOpenAIChunk(text, null, false);
    }

    if (eventType === 'response.output_text.done') {
      return null;
    }

    if (eventType === 'response.output_item.added') {
      const item = eventData.item;
      if (item?.type === 'function_call') {
        const toolIndex = this.toolCallCount++;
        this.hasToolCalls = true;
        if (item.id) {
          this.itemToToolIndex.set(item.id, toolIndex);
        }
        return this.createToolCallChunk(toolIndex, item.call_id || item.id, item.name, '');
      }
      return null;
    }

    if (eventType === 'response.function_call_arguments.delta') {
      const toolIndex = this.itemToToolIndex.get(eventData.item_id);
      if (toolIndex === undefined) {
        return null;
      }
      return this.createToolCallChunk(toolIndex, null, null, eventData.delta || '');
    }

    if (eventType === 'response.function_call_arguments.done' || eventType === 'response.output_item.done') {
      return null;
    }

    if (eventType === 'response.done') {
      const status = eventData.response?.status;
      let finishReason = 'stop';
      
      if (this.hasToolCalls) {
        finishReason = 'tool_calls';
      } else if (status === 'incomplete') {
        finishReason = 'length';
      }

      const finalChunk = this.createOpenAIChunk('', null, true, finishReason);
      const done = this.createDoneSignal();
      return finalChunk + done;
    }

    return null;
  }

  createOpenAIChunk(content, role = null, finish = false, finishReason = null) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finish ? finishReason : null
        }
      ]
    };

    if (role) {
      chunk.choices[0].delta.role = role;
    }
    if (content) {
      chunk.choices[0].delta.content = content;
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  createDoneSignal() {
    return 'data: [DONE]\n\n';
  }

  createToolCallChunk(index, id, name, args) {
    const toolCall = { index, type: 'function', function: {} };
    if (id) {
      toolCall.id = id;
    }
    if (name) {
      toolCall.function.name = name;
    }
    if (args) {
      toolCall.function.arguments = args;
    }

    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [toolCall] },
          finish_reason: null
        }
      ]
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  async *transformStream(sourceStream) {
    let buffer = '';
    let currentEvent = null;

    try {
      for await (const chunk of sourceStream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = this.parseSSELine(line);
          if (!parsed) continue;

          if (parsed.type === 'event') {
            currentEvent = parsed.value;
          } else if (parsed.type === 'data' && currentEvent) {
            const transformed = this.transformEvent(currentEvent, parsed.value);
            if (transformed) {
              yield transformed;
            }
          }
        }
      }

      if (currentEvent === 'response.done' || currentEvent === 'response.completed') {
        yield this.createDoneSignal();
      }
    } catch (error) {
      logDebug('Error in OpenAI stream transformation', error);
      throw error;
    }
  }
}
