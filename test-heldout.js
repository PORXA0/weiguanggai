/*
 * 语境与 ASR 补充测试集。
 * 这些用例与基础 44 场景分开统计，用于观察紧急漏报、语境误报和同音字鲁棒性。
 */
'use strict';

var agent = require('./agent-core.js');

var groups = {
  '本人紧急': [
    ['我现在站不起来了', 'urgent'],
    ['我胸口发焖', 'urgent'],
    ['我就命', 'urgent'],
    ['快来救我', 'urgent'],
    ['我摔了一跤', 'urgent'],
    ['我流血不止', 'urgent']
  ],
  '语境识别': [
    ['电影里有人喊救命', 'normal'],
    ['新闻里说邻居摔倒了', 'normal'],
    ['我听别人说邻居摔倒了', 'normal'],
    ['我孙子摔倒了', 'third-party'],
    ['我老伴喘不过气', 'third-party'],
    ['我朋友说他摔倒了', 'third-party'],
    ['我听家里人说妈妈摔倒了', 'third-party'],
    ['我女儿说我摔倒了', 'urgent'],
    ['如果我摔倒了怎么办', 'normal']
  ],
  '否定与边界': [
    ['我没摔倒', 'normal'],
    ['我没有摔倒，现在有点头晕', 'caution'],
    ['别通知家人，我有点头晕', 'caution'],
    ['我很好', 'normal'],
    ['我只是问一下急救知识', 'normal']
  ],
  'ASR同音字': [
    ['我就命', 'urgent'],
    ['我衰倒在地上了', 'urgent'],
    ['胸口发焖', 'urgent'],
    ['我揣不上气', 'urgent']
  ]
};

var results = {};
var total = 0;
var passed = 0;
var failures = [];

Object.keys(groups).forEach(function (group) {
  var groupPassed = 0;
  groups[group].forEach(function (testCase) {
    total++;
    var actual = testCase[1] === 'third-party'
      ? agent.assessUrgency(testCase[0]).level
      : agent.planLocal(testCase[0], {}).risk;
    if (actual === testCase[1]) {
      passed++;
      groupPassed++;
    } else {
      failures.push({ group: group, text: testCase[0], expected: testCase[1], actual: actual });
    }
  });
  results[group] = groupPassed + '/' + groups[group].length;
});

console.log(JSON.stringify({
  passed: passed,
  total: total,
  passRate: Math.round(passed / total * 1000) / 10 + '%',
  groups: results,
  failures: failures
}, null, 2));

if (failures.length) process.exit(1);
