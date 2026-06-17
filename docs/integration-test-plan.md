# 集成测试方案

coco-workspace · cws-core · cws-work · cws-comm · cws-kb · comm-kb 跨服务集成测试方案。

## 1. 服务拓扑

```
Client (coco-workspace / cws-fe)
   │  HTTPS REST + WSS
   ▼
cws-core (:8080)  ── 唯一外部网关，JWT 鉴权，路由代理
   ├──► cws-comm (:18085)   消息/会话/WS 推送
   ├──► cws-work (:18081)   项目/Issue/Task/Blueprint
   ├──► cws-kb  (:18084)    知识库/搜索
   └──► cws-as  (:18082)    文件存储

内部通信：
  cws-comm ──NATS JetStream──► WS fan-out
  cws-work ──gRPC──► cws-kb   (Task 创建时自动建 KB 目录)
  cws-work ──gRPC──► cws-comm (调度器 DM 投递)
  cws-kb   ──NATS──► Meilisearch (异步索引)
```

## 2. 现有覆盖 vs 缺口

### 已覆盖（integration-suite + smoke-suite，16 个用例）

| 领域 | 用例 | 覆盖服务 |
|------|------|----------|
| 项目 CRUD | smoke-0 | core |
| Issue 生命周期 | smoke-1/2/3 | core → work |
| Task 状态机 | smoke-2/3/9 | core → work |
| KB 树操作 | smoke-5/12 | core → kb |
| 身份/角色 | smoke-15 | core |
| 邀请 | smoke-16 | core |
| TM 元数据边界 | smoke-8 | core → work |
| KB 实例生命周期 | smoke-10 | core → kb |
| 会话生命周期 | smoke-13 | core → comm |
| 多 Agent 协作 | smoke-2(multi) | core → work → comm |
| KB 协作 | smoke-4(multi) | core → kb |
| 文件交接 | smoke-5(multi) | core → as |

### 缺口（本方案重点覆盖）

| 缺口 | 涉及服务 | 风险 |
|------|----------|------|
| **Agent 入驻全链路** | core (auth/invite) → workspace (config) | 新 agent 加入组织的完整流程未端到端验证 |
| **WS 实时推送一致性** | comm → workspace (WS) | 消息投递、序号连续性、断线重连、dedup |
| **Task → KB 自动建目录** | work → kb (gRPC) | task 创建的副作用未单独测试 |
| **Task → comm 调度 DM** | work → comm (gRPC) | 调度器 DM 投递未单独测试 |
| **KB 搜索索引管道** | kb → NATS → Meilisearch | 异步索引延迟、一致性 |
| **Policy 配置同步** | workspace → comm (WS connect) | v1.0.39 新特性，cws-comm 端未就绪 |
| **跨组织隔离** | core + comm + work + kb | 组织数据不应互相可见 |
| **服务降级/容错** | 全链路 | 下游不可用时的降级行为 |
| **Token 刷新 & 过期** | core (auth) → workspace | 长运行 agent 的 token 续期 |
| **消息同步(sync)** | workspace → core → comm | since_seq 断点续传正确性 |

## 3. 测试分层

```
                    ┌─────────────────────────┐
        L3          │   端到端场景测试 (E2E)    │  ← 真实用户流程
                    └────────────┬────────────┘
                    ┌────────────▼────────────┐
        L2          │   跨服务集成测试 (Cross)  │  ← 服务间接口验证
                    └────────────┬────────────┘
                    ┌────────────▼────────────┐
        L1          │  服务内集成测试 (Service)  │  ← 各服务已有
                    └─────────────────────────┘
```

- **L1（已有）**：各服务自带的 Go integration test（`-tags=integration`）
- **L2（本方案主体）**：跨服务接口验证，通过 cws-core 网关调用，验证下游联动
- **L3（本方案补充）**：完整用户场景（agent 入驻 → 接任务 → 执行 → 交付 → 搜索历史）

## 4. L2 跨服务测试用例

### 4.1 Auth & Agent 入驻（core）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| A-1 | Agent 入驻全链路 | admin 调 POST /invitations/agent → 获取 prompt → agent 用 api_key 换 JWT → accept invitation → 获取 org-scoped JWT | 全流程 200，agent 出现在 members 列表 |
| A-2 | Token 刷新 | 登录 → 等 access_token 接近过期 → POST /auth/refresh | 新 token 有效，旧 token 失效 |
| A-3 | WS Ticket 生命周期 | GET /auth/ws-ticket → 立即用连 WS（成功）→ 再用同一 ticket 连 WS（失败，一次性） | 第二次连接被拒 |
| A-4 | 无效 api_key | POST /auth/agent/token with bad key | 401 |
| A-5 | 跨组织 token 隔离 | agent 在 org-A 的 token 访问 org-B 资源 | 403 |

### 4.2 消息 & WS 推送（core → comm）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| M-1 | DM 收发 + WS 推送 | A 建 DM → A 发消息 → B 的 WS 收到推送 | WS 事件包含正确 message_id、seq、content |
| M-2 | 消息同步断点续传 | 发 10 条消息 → 记录 seq=5 → GET /sync?since_seq=5 | 只返回 seq 6-10 的消息 |
| M-3 | WS 断线重连 + dedup | WS 连接中途断开 → 重连 → 发消息 | 不产生重复消息，seq 连续 |
| M-4 | 大消息体 | 发送 50KB 文本消息 | 正常投递，内容完整 |
| M-5 | 并发消息 | 同时发 20 条消息 | 全部投递，seq 严格递增 |

### 4.3 Task 生命周期联动（core → work → kb/comm）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| T-1 | Task 创建自动建 KB 目录 | 创建 project → issue → task | task 关联的 KB 目录自动创建（GET /kbs/{id}/pages 能找到） |
| T-2 | Task 调度 DM | 创建 task → assign → 检查被分配者的 DM | 被分配者收到调度通知 DM |
| T-3 | Task 全状态机 | created → claim → in_progress → submit → accepted | 每个状态转换返回 200，最终状态正确 |
| T-4 | Task 非法转换 | created → 直接 submit（跳过 claim） | 400/409，状态未变 |
| T-5 | Blueprint 多步任务 | 创建 3 步 blueprint → worker claim step1 → complete → step2 auto-available | 步骤依赖关系正确执行 |

### 4.4 KB 搜索管道（core → kb → Meilisearch）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| K-1 | 写入后搜索 | POST /kbs/{id}/pages（含关键词）→ 等待索引 → POST /kbs/{id}/search | 搜索结果包含新建 page |
| K-2 | 索引延迟容忍 | 创建 page → 立即搜索（可能无结果）→ 3s 后重试 | 最终能搜到，延迟 <5s |
| K-3 | 更新后索引刷新 | 创建 page → 索引完成 → 更新 page 内容 → 搜索新内容 | 搜索结果反映更新 |
| K-4 | 删除后索引清理 | 创建 page → 索引完成 → 删除 page → 搜索 | 搜索结果不再包含已删除 page |
| K-5 | ReBAC 权限隔离 | user-A 创建私有 page → user-B 搜索同一 KB | user-B 搜索结果不包含 user-A 的私有 page |

### 4.5 Policy/Config 同步（workspace → comm）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| P-1 | WS 连接时同步 config | workspace WS 连接 → 检查 cws-comm 是否收到 config | POST /agents/config/sync 被调用（**依赖 cws-comm 实现**） |
| P-2 | 404 降级 | cws-comm 未部署 sync 端点 → workspace WS 连接 | WS 正常建立，sync 404 被静默忽略，不影响消息收发 |

### 4.6 跨组织隔离（全链路）

| ID | 用例 | 步骤 | 预期 |
|----|------|------|------|
| X-1 | 会话隔离 | agent 在 org-A 的 DM → 用 org-B token 访问该 DM | 403/404 |
| X-2 | 项目隔离 | org-A 创建 project → org-B token GET 该 project | 403/404 |
| X-3 | KB 隔离 | org-A 的 KB → org-B token 搜索 | 无结果 / 403 |

## 5. L3 端到端场景测试

### E2E-1：Agent 入驻 → 首次任务交付

```
1. Admin 创建 agent 邀请 (POST /invitations/agent)
2. Agent 用 prompt 中的指令完成入驻 (api_key → JWT → accept)
3. Agent 连接 WS，建立实时通道
4. Lead 创建 project + issue + task，assign 给 agent
5. Agent 通过 WS 收到通知
6. Agent claim task → 执行 → 上传文件到 AS → 写入 KB page → submit
7. Lead review → accept
8. 搜索 KB 验证交付物可检索
```

覆盖：core · comm · work · kb · as · workspace，6 个服务全链路。

### E2E-2：多 Agent 协作 + Blueprint

```
1. Lead 创建 3 步 Blueprint (research → implement → test)
2. Agent-A claim step 1 (research) → 写 KB page → complete
3. Agent-B claim step 2 (implement) → 读 Agent-A 的 KB page → 写代码 → complete
4. Agent-A claim step 3 (test) → 验证 → complete
5. Lead accept 整个 issue
```

覆盖：work 步骤依赖 · kb 跨 agent 协作 · comm 调度通知。

### E2E-3：断线恢复

```
1. Agent 建立 WS 连接，记录当前 seq
2. Agent 断开 WS
3. 期间 Lead 发 5 条消息
4. Agent 重连 → GET /sync?since_seq=N
5. 验证 5 条消息全部恢复，无丢失无重复
```

## 6. 技术方案

### 6.1 框架

沿用现有 integration-suite 模式：Node.js + `node:test` + `node:assert`，零外部依赖。

```
docs/cross-service-suite/
├── lib/
│   ├── client.js          # 复用 integration-suite/lib 的 HTTP client
│   ├── ws-helper.js       # WS 连接辅助（connect, waitForEvent, disconnect）
│   └── retry.js           # 搜索索引等异步操作的重试等待
├── cross-1-agent-onboard.test.js
├── cross-2-ws-delivery.test.js
├── cross-3-task-kb-provision.test.js
├── cross-4-search-pipeline.test.js
├── cross-5-org-isolation.test.js
├── e2e-1-first-task-delivery.test.js
├── e2e-2-multi-agent-blueprint.test.js
├── e2e-3-reconnect-recovery.test.js
└── README.md
```

### 6.2 测试环境

| 项 | 值 |
|----|---|
| 目标环境 | `https://cws-int.coco.xyz`（staging） |
| 认证 | CF-Access headers + 测试账号 JWT |
| 测试用户 | gavin-test-002 (org-owner), gavin-test-005 (org-member) |
| 测试 Agent | 动态创建（通过 invitation 接口），测试后清理 |
| 数据隔离 | 每次运行创建独立 project，测试后 archive |

### 6.3 已知问题处理

| 问题 | 处理方式 |
|------|----------|
| cws-comm #280: 新 DM 接收方 WS 未订阅 | WS 测试在 addRecipient 后重连再验证 |
| cws-kb #204: 旧 page 未索引 | 搜索测试每次新建 page，不依赖已有数据 |
| cws-kb #189: agent 写 KB 403 | KB 写操作使用 owner JWT |
| cws-core #76: 已激活用户重复 accept 500 | invitation 测试加幂等性守护 |
| Meilisearch 索引延迟 | 搜索验证使用 retry（最多 5s，间隔 500ms） |

### 6.4 执行方式

```bash
# 运行全部 L2 跨服务测试
node --test docs/cross-service-suite/cross-*.test.js

# 运行 E2E 场景测试（需要 worker agent）
SMOKE_WORKER_API_KEY=cwsk_... node --test docs/cross-service-suite/e2e-*.test.js

# CI 集成 — 加入 deploy gate
node docs/cross-service-suite/run-cross.js
```

### 6.5 执行频率

| 级别 | 频率 | 触发方式 |
|------|------|----------|
| L2 跨服务 | 每次部署后 | deploy hook / CI |
| L3 E2E | 每周 + 大版本前 | 手动 / scheduler |
| 全量回归 | 版本发布前 | L1 + L2 + L3 全跑 |

## 7. 优先级排期

| 阶段 | 用例 | 优先级 | 依赖 |
|------|------|--------|------|
| **Phase 1** | A-1 (Agent 入驻), M-1/M-2 (消息收发+同步), T-3 (Task 状态机) | P0 | 无 |
| **Phase 2** | T-1 (Task→KB), K-1/K-2 (搜索管道), X-1/X-2 (组织隔离) | P0 | Phase 1 的 client/lib |
| **Phase 3** | E2E-1 (首次交付), E2E-3 (断线恢复) | P1 | Phase 1+2 |
| **Phase 4** | E2E-2 (多 Agent), P-1 (Policy 同步) | P1 | cws-comm 端 sync 接口就绪 |
