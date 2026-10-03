import { logDebug } from '../logger.js';
import { getSystemPrompt, getUserAgent, getModelReasoning, getClientVersion } from '../config.js';
import { getOrgId } from '../auth.js';

export function transformToCommon(openaiRequest) {
  logDebug('Transforming OpenAI request to Common format');
  
  // 基本保持 OpenAI 格式，只在 messages 前面插入 system 消息
  const commonRequest = {
    ...openaiRequest
  };

  const systemPrompt = getSystemPrompt();
  
  if (systemPrompt) {
    // 检查是否已有 system 消息
    const hasSystemMessage = commonRequest.messages?.some(m => m.role === 'system');
    
    if (hasSystemMessage) {
      // 如果已有 system 消息，在第一个 system 消息前插入我们的 system prompt
      commonRequest.messages = commonRequest.messages.map((msg, index) => {
        if (msg.role === 'system' && index === commonRequest.messages.findIndex(m => m.role === 'system')) {
          // 找到第一个 system 消息，前置我们的 prompt
          return {
            role: 'system',
            content: systemPrompt + (typeof msg.content === 'string' ? msg.content : '')
          };
        }
        return msg;
      });
    } else {
      // 如果没有 system 消息，在 messages 数组最前面插入
      commonRequest.messages = [
        {
          role: 'system',
          content: systemPrompt
        },
        ...(commonRequest.messages || [])
      ];
    }
  }

  // Handle reasoning_effort field based on model configuration
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // Auto mode: preserve original request's reasoning_effort field exactly as-is
    // If original request has reasoning_effort field, keep it; otherwise don't add one
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // Specific level: override with model configuration
    commonRequest.reasoning_effort = reasoningLevel;
  } else {
    // Off or invalid: explicitly remove reasoning_effort field
    // This ensures any reasoning_effort field from the original request is deleted
    delete commonRequest.reasoning_effort;
  }

  logDebug('Transformed Common request', commonRequest);
  return commonRequest;
}

export function getCommonHeaders(authHeader, clientHeaders = {}, provider = 'baseten') {
  // Generate unique IDs if not provided
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();
  
  const headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'authorization': authHeader || '',
    'x-api-provider': provider,
    'x-factory-client': 'cli',
    'x-client-version': getClientVersion(),
    'x-provider-routing-source': 'registry_default',
    'x-session-id': sessionId,
    'x-assistant-message-id': messageId,
    'user-agent': getUserAgent(),
    'connection': 'keep-alive'
  };

  const orgId = getOrgId();
  if (orgId) {
    headers['x-factory-org-id'] = orgId;
  }

  // Pass through Stainless SDK headers with defaults
  const stainlessDefaults = {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '6.25.0',
    'x-stainless-runtime-version': 'v26.3.0'
  };

  // Copy Stainless headers from client or use defaults
  Object.keys(stainlessDefaults).forEach(header => {
    headers[header] = clientHeaders[header] || stainlessDefaults[header];
  });

  return headers;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
