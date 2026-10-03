import { logDebug } from '../logger.js';
import { getSystemPrompt, getModelReasoning, getModelFast, getUserAgent, getClientVersion } from '../config.js';
import { getOrgId } from '../auth.js';

export function transformToAnthropic(openaiRequest) {
  logDebug('Transforming OpenAI request to Anthropic format');
  
  const anthropicRequest = {
    model: openaiRequest.model,
    messages: []
  };

  // Only add stream parameter if explicitly provided by client
  if (openaiRequest.stream !== undefined) {
    anthropicRequest.stream = openaiRequest.stream;
  }

  // Handle max_tokens
  if (openaiRequest.max_tokens) {
    anthropicRequest.max_tokens = openaiRequest.max_tokens;
  } else if (openaiRequest.max_completion_tokens) {
    anthropicRequest.max_tokens = openaiRequest.max_completion_tokens;
  } else {
    anthropicRequest.max_tokens = 4096;
  }

  // Extract system message(s) and transform other messages
  let systemContent = [];
  
  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      // Handle system messages separately
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemContent.push({
            type: 'text',
            text: msg.content
          });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              systemContent.push({
                type: 'text',
                text: part.text
              });
            } else {
              systemContent.push(part);
            }
          }
        }
        continue; // Skip adding system messages to messages array
      }

      // Anthropic represents tool results as tool_result blocks inside a user message
      if (msg.role === 'tool') {
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: toToolResultContent(msg.content)
        };

        const lastMessage = anthropicRequest.messages[anthropicRequest.messages.length - 1];
        const lastHoldsToolResults = lastMessage
          && lastMessage.role === 'user'
          && Array.isArray(lastMessage.content)
          && lastMessage.content.length > 0
          && lastMessage.content.every(part => part.type === 'tool_result');

        if (lastHoldsToolResults) {
          lastMessage.content.push(toolResult);
        } else {
          anthropicRequest.messages.push({ role: 'user', content: [toolResult] });
        }
        continue;
      }

      const anthropicMsg = {
        role: msg.role,
        content: []
      };

      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          anthropicMsg.content.push({
            type: 'text',
            text: msg.content
          });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            if (part.text) {
              anthropicMsg.content.push({
                type: 'text',
                text: part.text
              });
            }
          } else if (part.type === 'image_url') {
            anthropicMsg.content.push({
              type: 'image',
              source: part.image_url
            });
          } else {
            anthropicMsg.content.push(part);
          }
        }
      }

      // Assistant tool_calls become tool_use content blocks
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          anthropicMsg.content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input: parseToolArguments(call.function?.arguments)
          });
        }
      }

      // Anthropic rejects messages with no content blocks
      if (anthropicMsg.content.length === 0) {
        continue;
      }

      anthropicRequest.messages.push(anthropicMsg);
    }
  }

  // Add system parameter with system prompt prepended
  const systemPrompt = getSystemPrompt();
  if (systemPrompt || systemContent.length > 0) {
    anthropicRequest.system = [];
    // Prepend system prompt as first element if it exists
    if (systemPrompt) {
      anthropicRequest.system.push({
        type: 'text',
        text: systemPrompt
      });
    }
    // Add user-provided system content
    anthropicRequest.system.push(...systemContent);
  }

  // Transform tools if present
  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    anthropicRequest.tools = openaiRequest.tools.map(tool => {
      if (tool.type === 'function') {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters || {}
        };
      }
      return tool;
    });
  }

  // Handle thinking field based on model configuration
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // Auto mode: preserve original request's thinking field exactly as-is
    if (openaiRequest.thinking !== undefined) {
      anthropicRequest.thinking = openaiRequest.thinking;
    }
    // If original request has no thinking field, don't add one
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // Specific level: override with model configuration
    const budgetTokens = {
      'low': 4096,
      'medium': 12288,
      'high': 24576,
      'xhigh': 24576
    };
    
    anthropicRequest.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens[reasoningLevel]
    };
  } else {
    // Off or invalid: explicitly remove thinking field
    // This ensures any thinking field from the original request is deleted
    delete anthropicRequest.thinking;
  }

  // Pass through other compatible parameters
  if (openaiRequest.temperature !== undefined) {
    anthropicRequest.temperature = openaiRequest.temperature;
  }
  if (openaiRequest.top_p !== undefined) {
    anthropicRequest.top_p = openaiRequest.top_p;
  }
  if (openaiRequest.stop !== undefined) {
    anthropicRequest.stop_sequences = Array.isArray(openaiRequest.stop) 
      ? openaiRequest.stop 
      : [openaiRequest.stop];
  }

  logDebug('Transformed Anthropic request', anthropicRequest);
  return anthropicRequest;
}

function toToolResultContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(part => (part.type === 'text' ? { type: 'text', text: part.text } : part));
  }
  return [{ type: 'text', text: '' }];
}

function parseToolArguments(args) {
  if (typeof args !== 'string') {
    return args ?? {};
  }
  try {
    return JSON.parse(args);
  } catch (e) {
    return {};
  }
}

export function getAnthropicHeaders(authHeader, clientHeaders = {}, isStreaming = true, modelId = null, provider = 'anthropic') {
  // Generate unique IDs if not provided
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();
  
  const headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'anthropic-version': clientHeaders['anthropic-version'] || '2023-06-01',
    'authorization': authHeader || '',
    'x-api-key': 'placeholder',
    'x-api-provider': provider,
    'x-factory-client': 'cli',
    'x-client-version': getClientVersion(),
    'x-provider-routing-source': 'registry_default',
    'x-session-id': sessionId,
    'x-assistant-message-id': messageId,
    'user-agent': getUserAgent(),
    'x-stainless-timeout': '600',
    'connection': 'keep-alive'
  }

  const orgId = getOrgId();
  if (orgId) {
    headers['x-factory-org-id'] = orgId;
  }

  // Handle anthropic-beta header based on reasoning configuration
  const reasoningLevel = modelId ? getModelReasoning(modelId) : null;
  // droid always opts into fine-grained tool streaming
  let betaValues = ['fine-grained-tool-streaming-2025-05-14'];
  
  // Add existing beta values from client headers
  if (clientHeaders['anthropic-beta']) {
    const existingBeta = clientHeaders['anthropic-beta'];
    for (const value of existingBeta.split(',').map(v => v.trim())) {
      if (value && !betaValues.includes(value)) {
        betaValues.push(value);
      }
    }
  }
  
  // Handle thinking beta based on reasoning configuration
  const thinkingBeta = 'interleaved-thinking-2025-05-14';
  if (reasoningLevel === 'auto') {
    // Auto mode: don't modify anthropic-beta header, preserve original
    // betaValues remain unchanged from client headers
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // Add thinking beta if not already present
    if (!betaValues.includes(thinkingBeta)) {
      betaValues.push(thinkingBeta);
    }
  } else {
    // Remove thinking beta if reasoning is off/invalid
    betaValues = betaValues.filter(v => v !== thinkingBeta);
  }
  
  // Add fast-mode beta if model has fast enabled
  const fastModeBeta = 'fast-mode-2026-02-01';
  if (modelId && getModelFast(modelId)) {
    if (!betaValues.includes(fastModeBeta)) {
      betaValues.push(fastModeBeta);
    }
  }

  // Set anthropic-beta header if there are any values
  if (betaValues.length > 0) {
    headers['anthropic-beta'] = betaValues.join(', ');
  }

  // Pass through Stainless SDK headers with defaults
  const stainlessDefaults = {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '0.70.1',
    'x-stainless-runtime-version': 'v26.3.0'
  };

  // Copy Stainless headers from client or use defaults
  Object.keys(stainlessDefaults).forEach(header => {
    headers[header] = clientHeaders[header] || stainlessDefaults[header];
  });

  // Override timeout from defaults if client provided
  if (clientHeaders['x-stainless-timeout']) {
    headers['x-stainless-timeout'] = clientHeaders['x-stainless-timeout'];
  }

  return headers;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
