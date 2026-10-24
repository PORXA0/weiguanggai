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
assert.strictEqual(agent.authorizeSensitive(sensitiveNotify, '我没有摔倒，别通知家人', { risk: 'normal' }), false,
  '明确的拒绝语句不能被误识别为通知授权');

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

var prototypePlan = agent.normalizePlan({
  goal: '原型链工具名不能穿透白名单',
  risk: 'normal',
  steps: [
    { tool: '__proto__', args: {} },
    { tool: 'constructor', args: {} },
    { tool: 'get_time', args: {} }
  ]
}, '现在几点');
assert.deepStrictEqual(tools(prototypePlan), ['get_time'], '对象原型属性不能伪装成合法工具');

var invalidArgsPlan = agent.normalizePlan({
  goal: '拒绝非法参数',
  risk: 'normal',
  steps: [
    { tool: 'open_page', args: { page: 'admin' } },
    { tool: 'get_time', args: {} }
  ]
}, '现在几点');
assert.deepStrictEqual(tools(invalidArgsPlan), ['get_time'], '非法枚举参数必须被工具契约拒绝');

assert.strictEqual(agent.validateToolArgs('create_reminder', {}).ok, false);
assert.strictEqual(agent.validateToolArgs('create_reminder', { text: '明天去医院' }).ok, true);
var catalog = agent.toolCatalog();
var createReminderMeta = catalog.filter(function (item) { return item.name === 'create_reminder'; })[0];
assert.strictEqual(createReminderMeta.effect.idempotency, 'required');
assert(createReminderMeta.inputSchema.required.indexOf('text') >= 0);

var unsafeModelPlan = agent.normalizePlan({
  goal: '聊天',
  risk: 'normal',
  steps: [{ tool: 'converse', args: { prompt: '不舒服' } }]
}, '我摔倒了，起不来');
assert.strictEqual(unsafeModelPlan.risk, 'urgent');
assert(tools(unsafeModelPlan).indexOf('notify_family') >= 0, '模型漏掉安全步骤时必须补齐');

var review = agent.safetyReview(unsafeModelPlan, '我摔倒了，起不来');
assert.strictEqual(review.agent, 'safety-agent');
assert.strictEqual(review.decision, 'approve', '补齐后的高风险计划应通过安全 Agent');

var weatherFailure = agent.replanAfterFailure(
  weather,
  { tool: 'get_weather' },
  { ok: false, text: '天气服务不可用' },
  '看看天气，然后提醒我下午去公园'
);
assert.strictEqual(weatherFailure.strategy, 'continue');
assert.strictEqual(weatherFailure.steps.length, 0);

var contactFailure = agent.replanAfterFailure(
  urgent,
  { tool: 'find_contact' },
  { ok: false, text: '没有联系人' },
  '我不舒服'
);
assert.strictEqual(contactFailure.strategy, 'ask-user');
assert.deepStrictEqual(tools(contactFailure), ['ask_user']);

var proactive = agent.planProactive({ type: 'inactive', hours: '8小时' });
assert.strictEqual(proactive.source, 'proactive-agent');
assert(tools(proactive).indexOf('ask_user') >= 0);

var escalation = agent.buildProactiveEscalation({ type: 'inactive', reason: '未回应' });
assert.strictEqual(escalation.risk, 'urgent');
assert(tools(escalation).indexOf('notify_family') >= 0);

var emergencyPhrases = [
  '救命',
  '快来救我',
  '我喘不过气',
  '我胸口发闷',
  '我现在站不起来',
  '我不小心磕破头了',
  '我找不到回家的路了'
];
emergencyPhrases.forEach(function (text) {
  var plan = agent.planLocal(text);
  assert.strictEqual(plan.risk, 'urgent', text + ' 必须识别为紧急情况');
  assert(tools(plan).indexOf('notify_family') >= 0, text + ' 必须准备通知家人');
});

var negatedEmergency = agent.planLocal('我没有摔倒，别通知家人');
assert.notStrictEqual(negatedEmergency.risk, 'urgent', '否定发生的紧急事件不能误报');
assert(tools(negatedEmergency).indexOf('notify_family') < 0, '否定请求不能自动通知家人');

var optOutDiscomfort = agent.planLocal('别通知家人，我只是有点头晕');
assert.strictEqual(optOutDiscomfort.risk, 'caution', '普通不适进入确认而不是紧急通知');
assert.deepStrictEqual(tools(optOutDiscomfort), ['get_care_status', 'ask_user']);
assert(tools(optOutDiscomfort).indexOf('notify_family') < 0);

var negatedButCurrentlyUnwell = agent.planLocal('我没有摔倒，但现在喘不上气');
assert.strictEqual(negatedButCurrentlyUnwell.risk, 'urgent', '其他真实紧急症状不能被否定词掩盖');

assert.strictEqual(agent.assessUrgency('如果我摔倒了怎么办').level, 'normal');
assert.strictEqual(agent.assessUrgency('我没摔倒').level, 'normal');

var mediaEmergency = agent.planLocal('电视里有人喊救命');
assert.strictEqual(mediaEmergency.risk, 'normal');
assert(tools(mediaEmergency).indexOf('notify_family') < 0);

var thirdPartyEmergency = agent.planLocal('我孙子摔倒了');
assert.strictEqual(thirdPartyEmergency.risk, 'caution');
assert.strictEqual(agent.assessUrgency('我孙子摔倒了').subject, 'third-party');
assert.deepStrictEqual(tools(thirdPartyEmergency), ['prepare_emergency_call', 'ask_user']);
var thirdPartyWithDetail = agent.planLocal('我孙子摔倒了，还有呼吸');
assert.deepStrictEqual(tools(thirdPartyWithDetail), ['prepare_emergency_call']);

var asrEmergency = agent.planLocal('我就命，揣不上气');
assert.strictEqual(asrEmergency.risk, 'urgent', '常见 ASR 同音字必须归一化后再判断');

var contactPending = agent.mergePendingInput({
  at: 1000,
  originalText: '帮我联系家人',
  slot: 'contact',
  resumeTool: 'find_contact'
}, '她是我女儿', 2000);
assert.strictEqual(contactPending.used, true);
assert(contactPending.text.indexOf('她是我女儿') >= 0);

var locationPending = agent.mergePendingInput({
  at: 1000,
  originalText: '我在哪里',
  slot: 'location'
}, '我在人民公园东门', 2000);
assert.strictEqual(locationPending.used, true);

var confirmationPending = agent.mergePendingInput({
  at: 1000,
  originalText: '要通知家人吗',
  slot: 'confirmation'
}, '好的，可以', 2000);
assert.strictEqual(confirmationPending.used, true);

var locationStep = { tool: 'get_location', requiresConfirmation: true };
assert.strictEqual(agent.authorizeSensitive(locationStep, '我迷路了', { risk: 'urgent' }), true);
assert.strictEqual(agent.authorizeSensitive(locationStep, '帮我看看天气', { risk: 'normal' }), false);

var groundedFailure = agent.composeGroundedAnswer({
  risk: 'normal',
  spoken: '我已经把提醒保存好了。'
}, [{
  step: { tool: 'create_reminder' },
  result: { ok: false, text: '我没有听清具体时间。' }
}], '提醒我出门');
assert(groundedFailure.indexOf('这件事没有全部完成') >= 0);
assert(groundedFailure.indexOf('已经保存') < 0, '模型预写回答不能覆盖真实失败');

var groundedConversation = agent.composeGroundedAnswer({
  risk: 'normal',
  spoken: '我在陪着你。'
}, [{
  step: { tool: 'converse' },
  result: { ok: true, text: '模型直接回答' }
}], '我有点孤单');
assert.strictEqual(groundedConversation, '我在陪着你。');

var groundedUrgentFailure = agent.composeGroundedAnswer({
  risk: 'urgent'
}, [{
  step: { tool: 'notify_family' },
  result: { ok: false, text: '通知失败' }
}], '我摔倒了');
assert(groundedUrgentFailure.indexOf('家人通知还没有成功') >= 0);

assert.deepStrictEqual(tools(agent.planLocal('我有哪些安排')), ['list_reminders']);
assert.deepStrictEqual(tools(agent.planLocal('取消明天去公园的提醒')), ['cancel_reminder']);
assert.deepStrictEqual(tools(agent.planLocal('把明天去医院的提醒改到下午三点')), ['update_reminder']);
assert.deepStrictEqual(tools(agent.planLocal('每天八点提醒我吃药')), ['create_recurring_reminder']);

console.log('Agent core tests passed:', 70);
