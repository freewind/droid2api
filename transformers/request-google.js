import { logDebug } from '../logger.js';
import { getSystemPrompt, getUserAgent, getModelReasoning, getClientVersion } from '../config.js';
import { getOrgId } from '../auth.js';

export function transformToGoogle(openaiRequest) {
  logDebug('Transforming OpenAI request to Google format');

  const googleRequest = {
    model: openaiRequest.model,
    contents: []
  };

  // Collect system parts: config system prompt first, then user system messages
  let systemParts = [];
  const systemPrompt = getSystemPrompt();

  if (systemPrompt) {
    systemParts.push({ text: systemPrompt });
  }

  // Transform messages to contents
  const toolNamesById = new Map();
  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemParts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              systemParts.push({ text: part.text });
            }
          }
        }
        continue;
      }

      // Tool results become functionResponse parts inside a user turn
      if (msg.role === 'tool') {
        const name = msg.name || toolNamesById.get(msg.tool_call_id);
        const { id } = splitThoughtSignature(msg.tool_call_id);
        const functionResponse = {
          name: name || 'unknown_function',
          response: toFunctionResponsePayload(msg.content)
        };
        if (id) {
          functionResponse.id = id;
        }

        const lastContent = googleRequest.contents[googleRequest.contents.length - 1];
        const lastHoldsFunctionResponses = lastContent
          && lastContent.role === 'user'
          && lastContent.parts.length > 0
          && lastContent.parts.every(part => part.functionResponse);

        if (lastHoldsFunctionResponses) {
          lastContent.parts.push({ functionResponse });
        } else {
          googleRequest.contents.push({ role: 'user', parts: [{ functionResponse }] });
        }
        continue;
      }

      // Map OpenAI "assistant" -> Google "model"
      const googleRole = msg.role === 'assistant' ? 'model' : msg.role;
      const googleMsg = {
        role: googleRole,
        parts: []
      };

      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          googleMsg.parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            if (part.text) {
              googleMsg.parts.push({ text: part.text });
            }
          } else if (part.type === 'image_url') {
            googleMsg.parts.push({
              inlineData: {
                mimeType: part.image_url.type || 'image/jpeg',
                data: part.image_url.url
              }
            });
          } else {
            googleMsg.parts.push(part);
          }
        }
      }

      // Assistant tool_calls become functionCall parts
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const name = call.function?.name;
          const { id, thoughtSignature } = splitThoughtSignature(call.id);

          if (id && name) {
            toolNamesById.set(call.id, name);
          }

          const part = {
            functionCall: {
              name,
              args: parseToolArguments(call.function?.arguments)
            }
          };
          if (id) {
            part.functionCall.id = id;
          }
          if (thoughtSignature) {
            part.thoughtSignature = thoughtSignature;
          }

          googleMsg.parts.push(part);
        }
      }

      if (googleMsg.parts.length > 0) {
        googleRequest.contents.push(googleMsg);
      }
    }
  }

  if (systemParts.length > 0) {
    googleRequest.systemInstruction = {
      parts: systemParts
    };
  }

  // Build generationConfig
  const generationConfig = {};

  if (openaiRequest.max_tokens) {
    generationConfig.maxOutputTokens = openaiRequest.max_tokens;
  } else if (openaiRequest.max_completion_tokens) {
    generationConfig.maxOutputTokens = openaiRequest.max_completion_tokens;
  }

  if (openaiRequest.temperature !== undefined) {
    generationConfig.temperature = openaiRequest.temperature;
  }
  if (openaiRequest.top_p !== undefined) {
    generationConfig.topP = openaiRequest.top_p;
  }
  if (openaiRequest.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(openaiRequest.stop)
      ? openaiRequest.stop
      : [openaiRequest.stop];
  }
  if (openaiRequest.presence_penalty !== undefined) {
    generationConfig.presencePenalty = openaiRequest.presence_penalty;
  }
  if (openaiRequest.frequency_penalty !== undefined) {
    generationConfig.frequencyPenalty = openaiRequest.frequency_penalty;
  }

  // Handle reasoning/thinking config via thinkingLevel
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // 保持原始请求的 thinkingConfig 不变
  } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
    const levelMap = { 'low': 'LOW', 'medium': 'MEDIUM', 'high': 'HIGH' };
    if (!generationConfig.thinkingConfig) {
      generationConfig.thinkingConfig = {};
    }
    generationConfig.thinkingConfig.thinkingLevel = levelMap[reasoningLevel];
  } else {
    // off 或无效：移除 thinkingConfig
    delete generationConfig.thinkingConfig;
  }

  if (Object.keys(generationConfig).length > 0) {
    googleRequest.generationConfig = generationConfig;
  }

  // Transform tools if present
  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    googleRequest.tools = [{
      functionDeclarations: openaiRequest.tools
        .filter(tool => tool.type === 'function')
        .map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: sanitizeSchemaForGoogle(tool.function.parameters || {})
        }))
    }];
  }

  logDebug('Transformed Google request', googleRequest);
  return googleRequest;
}

const THOUGHT_SIGNATURE_MARKER = '#ts=';

function splitThoughtSignature(toolCallId) {
  if (typeof toolCallId !== 'string') {
    return { id: toolCallId, thoughtSignature: null };
  }

  const at = toolCallId.indexOf(THOUGHT_SIGNATURE_MARKER);
  if (at === -1) {
    return { id: toolCallId, thoughtSignature: null };
  }

  const id = toolCallId.slice(0, at);
  const encoded = toolCallId.slice(at + THOUGHT_SIGNATURE_MARKER.length);

  try {
    return { id, thoughtSignature: Buffer.from(encoded, 'base64url').toString('utf8') };
  } catch (e) {
    return { id, thoughtSignature: null };
  }
}

function toFunctionResponsePayload(content) {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (e) {
      // fall through to a plain text payload
    }
    return { output: content };
  }
  if (content && typeof content === 'object') {
    return content;
  }
  return { output: '' };
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

const GOOGLE_SCHEMA_KEYS = [
  'description', 'format', 'pattern', 'minimum', 'maximum',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'default'
];

/**
 * Gemini rejects JSON Schema features such as union types and unknown keywords,
 * so reduce a tool parameter schema to the subset it accepts.
 */
function sanitizeSchemaForGoogle(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGoogle);
  }
  if (!schema || typeof schema !== 'object') {
    return { type: 'string' };
  }

  const result = {};
  let nullable = schema.nullable === true;
  let type = schema.type;

  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null');
    type = type.filter(entry => entry !== 'null')[0];
  }

  if (type && type !== 'null') {
    result.type = type;
  }

  if (schema.properties && typeof schema.properties === 'object') {
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      result.properties[key] = sanitizeSchemaForGoogle(value);
    }
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    result.required = schema.required;
  }

  if (schema.items) {
    result.items = sanitizeSchemaForGoogle(schema.items);
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(entry => entry !== null);
    if (values.length > 0) {
      result.enum = values;
    }
    if (values.length !== schema.enum.length) {
      nullable = true;
    }
  }

  for (const key of GOOGLE_SCHEMA_KEYS) {
    if (schema[key] !== undefined) {
      result[key] = schema[key];
    }
  }

  if (nullable) {
    result.nullable = true;
  }

  // Resolve unions that have no explicit type by taking the first usable branch
  if (!result.type) {
    const branches = schema.anyOf || schema.oneOf;
    if (Array.isArray(branches)) {
      const usable = branches
        .map(sanitizeSchemaForGoogle)
        .filter(branch => branch && branch.type && branch.type !== 'null');
      if (usable.length > 0) {
        Object.assign(result, usable[0]);
      }
    }
  }

  if (!result.type) {
    result.type = 'string';
  }

  return result;
}

export function getGoogleHeaders(authHeader, clientHeaders = {}, provider = 'google') {
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

  const headers = {
    'accept': '*/*',
    'content-type': 'application/json',
    'authorization': authHeader || '',
    'user-agent': getUserAgent(),
    'x-client-version': getClientVersion(),
    'x-factory-client': clientHeaders['x-factory-client'] || 'cli',
    'x-api-provider': provider,
    'x-provider-routing-source': 'registry_default',
    'x-assistant-message-id': messageId,
    'x-session-id': sessionId,
    'connection': 'keep-alive'
  };

  const orgId = getOrgId();
  if (orgId) {
    headers['x-factory-org-id'] = orgId;
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
