// 测试用：认出这次调用是谁在发言。
// 开启会话后，只有会话的第一条消息里有「你是「X」」，之后按会话 id 认人。
const bySession = new Map();

export function whoOf({ system, prompt, session } = {}) {
  const found = /你是「([^」]+)」/.exec(`${system ?? ''}\n${prompt ?? ''}`)?.[1];
  if (!session?.id) return found;
  if (found) bySession.set(session.id, found);
  return found ?? bySession.get(session.id);
}
