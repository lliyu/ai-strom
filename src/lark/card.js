/**
 * 生成 Lark 消息卡片（JSON 1.0 结构，自定义机器人与应用机器人都支持）。
 * 标题区颜色区分发言者，正文是 markdown，底部小字放模型与用量。
 */

const ENVELOPE_OVERHEAD = 200; // msg_type、timestamp、sign 等字段的余量

/** 卡片 markdown 不支持 # 标题：转成加粗行。 */
export function toCardMarkdown(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '**$1**')
    .trim();
}

/** 折叠面板（飞书 V7.9 及以上；更早的客户端会提示升级）。 */
function panel(title, content, expanded = false) {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: { title: { tag: 'markdown', content: title } },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content }],
  };
}

/**
 * brief 有值时卡片上只露出要点，详细内容（body）和完整方案（plan）放进折叠面板；
 * expanded 为 true 时详细内容默认展开（主席的汇总）。没有 brief 时整段正文直接显示。
 */
export function buildCard({ title, subtitle, color = 'grey', brief, body, plan, footer, expanded = false }) {
  const elements = [];
  const detail = toCardMarkdown(body);
  if (brief) {
    elements.push({ tag: 'markdown', content: toCardMarkdown(brief) });
    if (detail) elements.push(panel('**详细内容**', detail, expanded));
  } else {
    elements.push({ tag: 'markdown', content: detail || '（无内容）' });
  }
  if (plan) elements.push(panel('**当前完整方案**', toCardMarkdown(plan)));
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] });
  }
  const header = { template: color, title: { tag: 'plain_text', content: clip(title, 100) } };
  if (subtitle) header.subtitle = { tag: 'plain_text', content: clip(subtitle, 100) };
  return { config: { wide_screen_mode: true }, header, elements };
}

/**
 * 保证整条请求不超过 maxBytes（自定义机器人上限 20 KB）。
 * 超出时先去掉完整方案，再截断详细内容并追加提示，返回 { card, truncated }。
 */
export function buildCardWithinLimit(spec, { maxBytes = 18000, truncatedHint = '（内容过长已截断，完整内容见本机 ai-storm 网页）' } = {}) {
  const full = buildCard(spec);
  if (payloadBytes(full) <= maxBytes) return { card: full, truncated: false };
  if (spec.plan) {
    const noPlan = { ...spec, plan: undefined, body: `${spec.body ?? ''}\n\n${truncatedHint.replace('内容过长已截断', '完整方案太长没有附上')}` };
    const card = buildCard(noPlan);
    if (payloadBytes(card) <= maxBytes) return { card, truncated: true };
    spec = { ...spec, plan: undefined };
  }

  const body = toCardMarkdown(spec.body);
  let lo = 0;
  let hi = body.length;
  let best = buildCard({ ...spec, body: truncatedHint });
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = buildCard({ ...spec, body: `${body.slice(0, mid).trimEnd()}\n\n…${truncatedHint}` });
    if (payloadBytes(candidate) <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { card: best, truncated: true };
}

export function payloadBytes(card) {
  return Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', card }), 'utf8') + ENVELOPE_OVERHEAD;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
