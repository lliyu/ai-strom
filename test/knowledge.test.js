// 知识来源：登记、默认的 local 来源、索引写进提示词、读法与冲突规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { knowledgeSetup, inspectKnowledge, INDEX_MAX_CHARS, LOCAL_SOURCE } from '../src/knowledge.js';
import { ROOT } from '../src/tools/index.js';

const base = {
  participants: [{ id: 'a', provider: 'fake' }, { id: 'b', provider: 'fake' }],
  chair: { id: 'chair', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
};

function source(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-know-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

test('配置：默认带上 local 来源，路径解析，index 校验', () => {
  const c = normalizeConfig(base);
  assert.deepEqual(Object.keys(c.knowledge), [LOCAL_SOURCE]);
  assert.equal(c.knowledge.local.path, path.join(ROOT, 'local/knowledge'));
  const c2 = normalizeConfig({ ...base, knowledge: { hotel: { path: '/x/hotel', index: ['knowledge/INDEX.md'], description: 'insight' } } });
  assert.deepEqual(c2.knowledge.hotel, { path: '/x/hotel', index: ['knowledge/INDEX.md'], description: 'insight' });
  assert.ok(c2.knowledge.local);
  assert.equal(normalizeConfig(c2).knowledge.hotel.path, '/x/hotel', '再规范化一次不变');
  assert.equal(normalizeConfig({ ...base, knowledge: { mine: { path: '~/k' } } }).knowledge.mine.path, path.join(os.homedir(), 'k'));
  const bad = (knowledge, re) => assert.throws(() => normalizeConfig({ ...base, knowledge }), re);
  bad({ x: {} }, /缺少 path/);
  bad({ x: { path: '/x', index: ['../secret.md'] } }, /index 需要是相对 path/);
  bad({ x: { path: '/x', index: '/abs.md' } }, /index 需要是相对 path/);
  bad({ 'a b': { path: '/x' } }, /名字只能用/);
  bad([], /需要是对象/);
});

test('提示词：各来源的索引、读法、冲突规则；目录不存在的跳过', () => {
  const hotel = source({ 'knowledge/INDEX.md': '| [时区](hotel/tz.md) | 存 UTC |', 'knowledge/hotel/tz.md': '# 时区', 'playbooks/INDEX.md': '| 排查 |' });
  const local = source({ 'INDEX.md': '| [时间字段](hotel/time-fields.md) |', 'hotel/time-fields.md': '# x' });
  const knowledge = {
    hotel: { path: hotel, index: ['knowledge/INDEX.md', 'playbooks/INDEX.md', 'missing.md'], description: 'insight 的 hotel' },
    local: { path: local, index: ['INDEX.md'], description: '' },
    gone: { path: path.join(hotel, 'nope'), index: ['INDEX.md'], description: '' },
  };
  const s = knowledgeSetup(knowledge);
  assert.deepEqual(s.sources, ['hotel', 'local']);
  assert.deepEqual(s.dirs, [hotel, local]);
  assert.match(s.skipped[0].reason, /目录不存在/);
  assert.match(s.block, /### 来源「hotel」：insight 的 hotel/);
  assert.match(s.block, /#### knowledge\/INDEX\.md\n\| \[时区\]/);
  assert.match(s.block, /#### playbooks\/INDEX\.md/);
  assert.doesNotMatch(s.block, /missing\.md/);
  assert.match(s.block, /索引里的链接相对于索引文件所在的目录/);
  assert.match(s.block, /来源名:相对路径/);
  assert.match(s.block, /以实时证据为准/);
  assert.match(s.block, /两边都列出来，写明冲突/);
  // 只选部分来源
  assert.deepEqual(knowledgeSetup(knowledge, ['local']).sources, ['local']);
  // 一个都没有时不写
  assert.deepEqual(knowledgeSetup(knowledge, ['gone']).block, '');
  const [h] = inspectKnowledge({ hotel: knowledge.hotel });
  assert.equal(h.docs, 3);
  assert.deepEqual(h.indexes.map((i) => i.exists), [true, true, false]);
});

test('提示词：没有索引时提示用 Glob；索引太长时截断并说明', () => {
  const noIndex = source({ 'a.md': '# a' });
  assert.match(knowledgeSetup({ k: { path: noIndex, index: ['INDEX.md'], description: '' } }).block, /没有索引文件，用 Glob/);
  const long = source({ 'INDEX.md': 'x'.repeat(INDEX_MAX_CHARS + 50) });
  const block = knowledgeSetup({ k: { path: long, index: ['INDEX.md'], description: '' } }).block;
  assert.match(block, /索引超过 \d+ 字，后面的部分没放进来/);
  assert.ok(!block.includes('x'.repeat(INDEX_MAX_CHARS + 1)));
});
