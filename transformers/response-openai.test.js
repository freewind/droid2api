import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIResponseTransformer } from './response-openai.js';

function encodeEvent(data) {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function replay(events) {
  const input = events.map(encodeEvent).join('');
  async function* source() {
    // 让事件名称和 JSON 跨网络数据块，验证流式拼接。
    for (let offset = 0; offset < input.length; offset += 7) {
      yield Buffer.from(input.slice(offset, offset + 7));
    }
  }
  let output = '';
  const transformer = new OpenAIResponseTransformer('test-model', 'test-request');
  for await (const chunk of transformer.transformStream(source())) output += chunk;
  return output.split('\n').filter(line => line.startsWith('data: ')).map(line => {
    const value = line.slice(6);
    return value === '[DONE]' ? value : JSON.parse(value);
  });
}

const cases = [
  ['文本完成', 'response.completed', 'completed', false, 'stop'],
  ['工具调用完成', 'response.completed', 'completed', true, 'tool_calls'],
  ['文本截断', 'response.incomplete', 'incomplete', false, 'length'],
  ['工具参数截断', 'response.incomplete', 'incomplete', true, 'length'],
  ['旧版文本完成', 'response.done', 'completed', false, 'stop'],
  ['旧版工具调用完成', 'response.done', 'completed', true, 'tool_calls'],
  ['旧版工具参数截断', 'response.done', 'incomplete', true, 'length']
];

for (const [name, type, status, tool, finishReason] of cases) {
  test(name, async () => {
    const events = [{ type: 'response.created', response: { status: 'in_progress' } }];
    if (tool) {
      events.push(
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read' } },
        { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"path":"test"}' }
      );
    } else {
      events.push({ type: 'response.output_text.delta', delta: 'hello' });
    }
    events.push({ type, response: { status } });

    const frames = await replay(events);
    const chunks = frames.filter(frame => frame !== '[DONE]');
    assert.deepEqual(chunks.map(chunk => chunk.choices[0].finish_reason).filter(Boolean), [finishReason]);
    assert.equal(frames.filter(frame => frame === '[DONE]').length, 1);
    assert.equal(frames.at(-1), '[DONE]');
    assert.equal(frames.at(-2).choices[0].finish_reason, finishReason);
    if (tool) {
      const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? []);
      assert.equal(calls[0].id, 'call-1');
      assert.equal(calls[0].function.name, 'read');
      assert.equal(calls[1].function.arguments, '{"path":"test"}');
    } else {
      assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), 'hello');
    }
  });
}

test('上游提前断流不伪造正常结束', async () => {
  const frames = await replay([
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'partial' }
  ]);
  assert.equal(frames.includes('[DONE]'), false);
  assert.equal(frames.some(frame => frame.choices[0].finish_reason), false);
});
