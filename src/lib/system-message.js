/**
 * Helpers for platform System Member messages (调度中心 等播报源).
 *
 * A System Member is a trusted, write-only platform broadcast identity
 * (`sender_type=SYSTEM`). It is NOT a human/agent participant, so the dmPolicy /
 * groupPolicy / owner-binding gates that exist to filter human/agent senders
 * must not apply to it — see comm-bridge `shouldHandleMessage`.
 *
 * Wire shape (cws-int 实测，DM 019ec4ea 的 SYSTEM 消息)：
 *   { sender_type: "SYSTEM", type: "TEXT",
 *     content: { content_type: "text", body: { text: "[调度中心] …" } } }
 * 当前部署的系统消息**尚未携带** `metadata.systemEvent`，所以 priority 读取要
 * 容缺省（无 systemEvent → 不带 --priority，c4-receive 默认 normal）。一旦
 * cws-work / cws-core 按设计透出 metadata，这里即可生效，无需再改。
 *
 * 设计依据：cws-docs/architecture/v0.7-event-delivery-design.md §5 / §6.3。
 */

// metadata.systemEvent.priority(urgent|high|normal) → c4-receive --priority(1|2|3)
const PRIORITY_BY_NAME = { urgent: 1, high: 2, normal: 3 };

/**
 * Whether a message was sent by a platform System Member.
 * Reads both the top-level `sender_type` (real-time WS frames) and the nested
 * `message.sender_type` (get-message detail envelope), so detection is uniform
 * regardless of arrival path.
 */
export function isSystemSender(msg) {
  if (!msg) return false;
  const t = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
  return t === 'SYSTEM';
}

/**
 * c4-receive `--priority` (1=urgent / 2=high / 3=normal) for a system message,
 * read from `metadata.systemEvent.priority` wherever cws-core surfaces it.
 * Returns `undefined` when the message carries no `systemEvent` (caller then
 * omits the flag and c4-receive applies its default of 3). An unrecognized
 * priority on an otherwise-present systemEvent degrades to 3 (normal).
 */
export function systemEventPriority(msg) {
  const se =
       msg?.content?.metadata?.systemEvent
    || msg?.metadata?.systemEvent
    || msg?.message?.content?.metadata?.systemEvent;
  if (!se) return undefined;
  return PRIORITY_BY_NAME[String(se.priority || '').toLowerCase()] || 3;
}
