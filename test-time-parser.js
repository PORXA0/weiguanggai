/* 中文日程时间解析回归测试。 */
'use strict';

var assert = require('assert');
var parser = require('./time-parser.js');

var now = new Date(2026, 9, 24, 9, 0, 0);

function hm(result) {
  return result && result.at
    ? result.at.getFullYear() + '-' +
      String(result.at.getMonth() + 1).padStart(2, '0') + '-' +
      String(result.at.getDate()).padStart(2, '0') + ' ' +
      String(result.at.getHours()).padStart(2, '0') + ':' +
      String(result.at.getMinutes()).padStart(2, '0')
    : '';
}

var normal = parser.parseWhen('明天下午三点提醒我吃药', now);
assert.strictEqual(hm(normal), '2026-10-25 15:00');
assert.strictEqual(normal.ambiguous, false);

var clock = parser.parseWhen('后天上午十点一刻去公园', now);
assert.strictEqual(hm(clock), '2026-10-26 10:15');

var minute = parser.parseWhen('25分钟后提醒我关火', now);
assert.strictEqual(hm(minute), '2026-10-24 09:25');

var invalidHour = parser.parseWhen('明天25点提醒我吃药', now);
assert.strictEqual(invalidHour.error, 'invalid-time');

var invalidMinute = parser.parseWhen('明天12:99提醒我吃药', now);
assert.strictEqual(invalidMinute.error, 'invalid-time');

var missingClock = parser.parseWhen('明天下午提醒我吃药', now);
assert.strictEqual(missingClock.error, 'missing-clock');

var ambiguousMorning = parser.parseWhen('明天8点提醒我吃药', now);
assert.strictEqual(ambiguousMorning.ambiguous, true);

var explicitMorning = parser.parseWhen('明天上午8点提醒我吃药', now);
assert.strictEqual(explicitMorning.ambiguous, false);
assert.strictEqual(hm(explicitMorning), '2026-10-25 08:00');

var midnight = parser.parseWhen('明天晚上12点提醒我关灯', now);
assert.strictEqual(midnight.ambiguous, true);
assert.strictEqual(hm(midnight), '2026-10-25 00:00');

var earlyMorning = parser.parseWhen('明天凌晨12点提醒我关灯', now);
assert.strictEqual(earlyMorning.ambiguous, true);
assert.strictEqual(hm(earlyMorning), '2026-10-25 00:00');

var noon = parser.parseWhen('明天中午12点提醒我吃饭', now);
assert.strictEqual(hm(noon), '2026-10-25 12:00');

var justAfterNoon = parser.parseWhen('明天中午1点提醒我吃药', now);
assert.strictEqual(hm(justAfterNoon), '2026-10-25 13:00');

console.log('Time parser tests passed:', 17);
