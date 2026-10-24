/* 离线 Agent 场景基准：检查任务规划、工具选择和高风险安全策略。 */
'use strict';

var agent = require('./agent-core.js');

var cases = [
  { text: '现在几点了', tools: ['get_time'], risk: 'normal' },
  { text: '今天几号', tools: ['get_time'], risk: 'normal' },
  { text: '今天天气怎么样', tools: ['get_weather'], risk: 'normal' },
  { text: '明天会不会下雨', tools: ['get_weather'], risk: 'normal' },
  { text: '我今天吃什么药', tools: ['get_medication_schedule'], risk: 'normal' },
  { text: '我今天吃过药了吗', tools: ['get_medication_status'], risk: 'normal' },
  { text: '降压药吃了没有', tools: ['get_medication_status'], risk: 'normal' },
  { text: '有人说我中奖了，让我先交钱', tools: ['check_fraud'], risk: 'caution' },
  { text: '他说我涉嫌洗钱，要转到安全账户', tools: ['check_fraud'], risk: 'caution' },
  { text: '对方让我报验证码', tools: ['check_fraud'], risk: 'caution' },
  { text: '有个客服说要给我退款', tools: ['check_fraud'], risk: 'caution' },
  { text: '给女儿打电话', tools: ['find_contact', 'prepare_call'], risk: 'normal' },
  { text: '联系一下儿子', tools: ['find_contact', 'prepare_call'], risk: 'normal' },
  { text: '提醒我去医院', tools: ['ask_user'], risk: 'normal' },
  { text: '明天下午三点提醒我去医院', tools: ['create_reminder'], risk: 'normal' },
  { text: '记住我晚上不吃太咸', tools: ['remember_fact'], risk: 'normal' },
  { text: '我要去人民公园', tools: ['open_page'], risk: 'normal' },
  { text: '你在哪里', tools: ['get_care_status', 'get_location'], risk: 'normal' },
  { text: '看看我最近有没有动静', tools: ['get_care_status'], risk: 'normal' },
  { text: '你能帮我做什么', tools: ['converse'], risk: 'normal' },
  { text: '我不舒服', tools: ['get_care_status', 'find_contact', 'notify_family', 'prepare_call'], risk: 'urgent' },
  { text: '我摔倒了，起不来', tools: ['get_care_status', 'find_contact', 'notify_family', 'prepare_call'], risk: 'urgent' },
  { text: '我喘不上气', tools: ['get_care_status', 'find_contact', 'notify_family', 'prepare_call'], risk: 'urgent' },
  { text: '胸口疼得厉害', tools: ['get_care_status', 'find_contact', 'notify_family', 'prepare_call'], risk: 'urgent' },
  { text: '我头晕，帮我通知家人，再给女儿打电话', tools: ['get_care_status', 'find_contact', 'notify_family', 'prepare_call'], risk: 'urgent' },
  { text: '如果我摔倒了怎么办', notRisk: 'urgent' },
  { text: '假如我不舒服要联系谁', notRisk: 'urgent' },
  { text: '先看看天气，然后提醒我下午去公园', contains: ['get_weather', 'create_reminder'], remote: true },
  { text: '我今天吃过药了吗，如果没吃就提醒我', tools: ['get_medication_status'], remote: true },
  { text: '有人说我洗钱，我想给女儿打电话', contains: ['check_fraud', 'find_contact', 'prepare_call'], risk: 'caution' }
];

var passed = 0;
var failures = [];

cases.forEach(function (test) {
  var plan = agent.planLocal(test.text, {});
  var toolNames = plan.steps.map(function (step) { return step.tool; });
  var ok = true;
  if (test.tools && JSON.stringify(toolNames) !== JSON.stringify(test.tools)) ok = false;
  if (test.contains && !test.contains.every(function (name) { return toolNames.indexOf(name) >= 0; })) ok = false;
  if (test.risk && plan.risk !== test.risk) ok = false;
  if (test.notRisk && plan.risk === test.notRisk) ok = false;
  if (test.remote != null && agent.shouldUseRemote(test.text, plan) !== test.remote) ok = false;
  if (ok) passed++;
  else failures.push({ text: test.text, expected: test, actual: { tools: toolNames, risk: plan.risk } });
});

var proactive = agent.planProactive({ type: 'inactive', hours: '8小时' });
var proactiveTools = proactive.steps.map(function (step) { return step.tool; });
if (proactiveTools.indexOf('get_care_status') >= 0 && proactiveTools.indexOf('ask_user') >= 0) passed++;
else failures.push({ text: 'proactive check-in', actual: proactiveTools });
cases.push({ text: 'proactive check-in' });

var escalated = agent.buildProactiveEscalation({ type: 'inactive', reason: '未回应' });
var escalatedTools = escalated.steps.map(function (step) { return step.tool; });
if (escalatedTools.indexOf('notify_family') >= 0 && escalatedTools.indexOf('prepare_call') >= 0) passed++;
else failures.push({ text: 'proactive escalation', actual: escalatedTools });
cases.push({ text: 'proactive escalation' });

var safetyPlan = agent.planLocal('我摔倒了', {});
var safety = agent.safetyReview(safetyPlan, '我摔倒了');
if (safety.decision === 'approve' && safety.agent === 'safety-agent') passed++;
else failures.push({ text: 'safety review', actual: safety });
cases.push({ text: 'safety review' });

var recovery = agent.replanAfterFailure(
  agent.planLocal('看看天气，然后提醒我下午去公园', {}),
  { tool: 'get_weather' },
  { ok: false, text: '服务不可用' },
  '看看天气，然后提醒我下午去公园'
);
if (recovery && recovery.strategy === 'continue') passed++;
else failures.push({ text: 'weather replan', actual: recovery });
cases.push({ text: 'weather replan' });

var rate = Math.round(passed / cases.length * 1000) / 10;
console.log(JSON.stringify({
  passed: passed,
  total: cases.length,
  passRate: rate + '%',
  failures: failures
}, null, 2));

if (failures.length) process.exit(1);
