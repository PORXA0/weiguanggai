/* 无网络、无大模型的 Agent 规划与安全门测试。 */
'use strict';

var assert = require('assert');
var agent = require('./agent-core.js');

function tools(plan) {
  return plan.steps.map(function (s) { return s.tool; });
}

var urgent = agent.planLocal('我不舒服，帮我通知家人，再给女儿打电话');
assert.strictEqual(urgent.risk, 'urgent');
assert(tools(urgent).indexOf('notify_family') >= 0, '紧急场景必须通知家人');
assert(tools(urgent).indexOf('prepare_call') >= 0, '紧急场景必须准备拨号');
assert.strictEqual(agent.shouldUseRemote('我不舒服，帮我通知家人，再给女儿打电话', urgent), false,
  '紧急场景不应等待远程模型规划');

var hypothetical = agent.planLocal('如果我摔倒了怎么办');
assert.notStrictEqual(hypothetical.risk, 'urgent', '假设句不能误报紧急事件');

var med = agent.planLocal('我今天吃过药了吗');
assert.deepStrictEqual(tools(med), ['get_medication_status']);

var fraud = agent.planLocal('他说我洗钱，让我转到安全账户');
assert.deepStrictEqual(tools(fraud), ['check_fraud']);
assert.strictEqual(fraud.risk, 'caution');

var weather = agent.planLocal('看看天气，然后提醒我下午去公园');
assert(tools(weather).indexOf('get_weather') >= 0);
assert(tools(weather).indexOf('create_reminder') >= 0);
assert.strictEqual(agent.shouldUseRemote('看看天气，然后提醒我下午去公园', weather), true);

var incompleteReminder = agent.planLocal('提醒我去医院');
assert.deepStrictEqual(tools(incompleteReminder), ['ask_user'], '缺少时间时必须追问');
var resumed = agent.mergePendingInput({
  at: 1000,
  originalText: '提醒我去医院',
  tool: 'create_reminder'
}, '明天下午三点', 2000);
assert.strictEqual(resumed.used, true);
assert.strictEqual(resumed.text, '提醒我去医院，明天下午三点');

var sensitiveNotify = { tool: 'notify_family', requiresConfirmation: true };
assert.strictEqual(agent.authorizeSensitive(sensitiveNotify, '我有点冷', { risk: 'normal' }), false,
  '模型推断出的敏感通知必须确认');
assert.strictEqual(agent.authorizeSensitive(sensitiveNotify, '帮我通知家里人', { risk: 'normal' }), true,
  '老人明确授权时可以执行');
assert.strictEqual(agent.authorizeSensitive(sensitiveNotify, '我摔倒了', { risk: 'urgent' }), true,
  '紧急场景允许自动通知家人');

var modelPlan = agent.normalizePlan({
  goal: '连续完成两件事',
  risk: 'normal',
  steps: [
    { tool: 'get_weather', args: {}, purpose: '查天气' },
    { tool: 'invalid_tool', args: {} },
    { tool: 'create_reminder', args: { text: '下午去公园' } }
  ]
}, '先看看天气，再提醒我下午去公园');
assert.deepStrictEqual(tools(modelPlan), ['get_weather', 'create_reminder']);
assert.strictEqual(modelPlan.source, 'llm');

var unsafeModelPlan = agent.normalizePlan({
  goal: '聊天',
  risk: 'normal',
  steps: [{ tool: 'converse', args: { prompt: '不舒服' } }]
}, '我摔倒了，起不来');
assert.strictEqual(unsafeModelPlan.risk, 'urgent');
assert(tools(unsafeModelPlan).indexOf('notify_family') >= 0, '模型漏掉安全步骤时必须补齐');

console.log('Agent core tests passed:', 12);
