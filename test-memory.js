/* 长期记忆检索与管理测试。 */
'use strict';

var assert = require('assert');
var memory = require('./memory.js');
var now = Date.now();
var facts = [
  { id: '1', at: now, text: '我不喜欢吃太咸', category: 'preference', source: 'test' },
  { id: '2', at: now - 86400000, text: '我常去人民公园散步', category: 'fact', source: 'test' },
  { id: '3', at: now - 172800000, text: '女儿住在成都', category: 'fact', source: 'test' }
];

var relevant = memory.retrieveFacts(facts, '今天想去人民公园走走', 2, now);
assert.strictEqual(relevant[0].id, '2', '记忆检索必须优先返回与当前目标相关的事实');

var added = memory.addFact(facts, {
  id: '4',
  text: '晚上八点以后不想被打扰',
  category: 'preference'
});
assert.strictEqual(added.category, 'preference');
assert.strictEqual(facts.length, 4);

var duplicate = memory.addFact(facts, { text: '晚上八点以后不想被打扰' });
assert.strictEqual(duplicate.id, added.id, '相同文本不能重复写入');
assert.strictEqual(memory.removeFact(facts, added.id), true);
assert.strictEqual(memory.removeFact(facts, 'missing'), false);

console.log('Memory tests passed');
