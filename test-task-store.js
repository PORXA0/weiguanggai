/* Agent 持久任务账本测试。 */
'use strict';

var assert = require('assert');
var store = require('./task-store.js');

var tasks = [];
var created = store.create(tasks, {
  goal: '明天下午提醒我去医院',
  status: 'queued'
});
assert.strictEqual(tasks.length, 1);
assert.strictEqual(created.status, 'queued');

var running = store.update(tasks, created.id, {
  status: 'running',
  currentStep: '创建提醒',
  attempts: 1
});
assert.strictEqual(running.currentStep, '创建提醒');
assert.strictEqual(running.attempts, 1);
assert.strictEqual(store.isActive(running), true);

var interrupted = store.recoverInterrupted(tasks);
assert.strictEqual(interrupted.length, 1);
assert.strictEqual(tasks[0].status, 'interrupted');
assert.strictEqual(store.isActive(tasks[0]), false);

var completed = store.update(tasks, created.id, {
  status: 'completed',
  error: ''
});
assert.strictEqual(completed.status, 'completed');

for (var i = 0; i < store.MAX_TASKS + 5; i++) {
  store.create(tasks, { goal: '任务 ' + i, status: 'completed' });
}
assert.strictEqual(tasks.length, store.MAX_TASKS);
assert.strictEqual(store.recent(tasks, 3).length, 3);

console.log('Task store tests passed');
