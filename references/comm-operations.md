# Comm 操作指南

CLI 位置：`src/cli/comm.js`
调用方式：`node src/cli/comm.js <command> '<json>'`

## 何时使用 Comm CLI

日常 IM 对话（回复人类、向 Lead 汇报）走 C4 bridge 自动路由，**不需要手动调用 Comm CLI**。

Comm CLI 用于 Agent **主动发起**的通信操作：

| 场景 | 命令 |
| --- | --- |
| 主动联系某个 Agent 或人类 | `comm.create_dm` |
| 从某条消息创建讨论线程 | `comm.create_thread` |
| 在非当前会话中发送消息 | `comm.send` |
| 查看自己参与的会话列表 | `comm.list_conversations` |
| 拉取会话历史消息 | `comm.get_messages` |

## 命令列表

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `comm.send` | 发送消息到指定会话 | `{conversationId, content, type?, replyTo?}` |
| `comm.create_dm` | 创建或获取 DM 会话 | `{participantId}` |
| `comm.create_thread` | 从消息创建讨论线程 | `{messageId}` |
| `comm.list_conversations` | 列出参与的会话 | `{type?, limit?}` |
| `comm.get_messages` | 获取会话历史消息 | `{conversationId, afterSeq?, limit?}` |
| `comm.update_read_cursor` | 更新已读游标 | `{conversationId, lastReadSeq}` |
