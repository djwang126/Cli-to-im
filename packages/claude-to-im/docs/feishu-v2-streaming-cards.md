# 飞书流式卡片与权限按钮

> 状态：**已实现**
> 口径：飞书官方当前可用方案是 **CardKit v1 OpenAPI + schema 2.0 卡片 JSON**

## 背景

仓库里早期方案把飞书流式卡片写成了 `cardkit.v2` 调用，但当前使用的 `@larksuiteoapi/node-sdk` 实际暴露的是 `cardkit.v1`。  
本项目现在统一采用官方文档对应的实现：

- 卡片实体接口：`cardkit.v1.card.create / settings / update`
- 流式文本接口：`cardkit.v1.cardElement.content`
- 卡片内容格式：`schema: "2.0"` 的卡片 JSON
- 按钮回调：`card.action.trigger` 通过 WSClient 长连接接收

## 设计结论

### 1. 流式回复卡片

使用以下调用序列：

1. `POST /open-apis/cardkit/v1/cards` 创建卡片实体，卡片 JSON 使用 `schema: "2.0"`，并在 `config.streaming_mode` 中开启流式模式
2. `POST /open-apis/im/v1/messages` 或 `reply` 发送 `{type:"card",data:{card_id}}`
3. `PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content` 对固定 `element_id` 执行流式文本更新
4. `PATCH /open-apis/cardkit/v1/cards/{card_id}/settings` 关闭 `streaming_mode`
5. `PUT /open-apis/cardkit/v1/cards/{card_id}` 用最终内容、工具进度和 footer 做全量更新

实现要点：

- 固定流式元素 ID：`streaming_content`
- 最终卡片按时间顺序渲染单条内容流，流式正文增量和工具事件混排显示
- 不再拆成“正文区 + 过程区”，也不再用总结页覆盖已经上屏的正文
- sequence 严格递增
- 流式更新做节流，并串行等待上一次更新完成后再发下一次
- 若创建失败、发送实体失败、关闭流式失败或最终更新失败，桥接层回退到普通消息发送，保证最终内容不丢

### 2. 普通卡片

普通复杂 markdown 卡片仍走 `im.message.create` 的 `msg_type=interactive` 路径，直接发送 schema 2.0 JSON，不强制改成卡片实体。

### 3. 权限按钮卡片

权限卡继续走 `msg_type=interactive` 直接发送 schema 2.0 JSON。

- 正式回调命名空间：`perm:*`
- 诊断回调命名空间：`diag:*`
- `diag:*` 只回 toast 和日志，不进入真实审批链路
- 三个动作按钮按 3 行纵向排列，优先保证手机端可读性

## 关键实现点

- `feishu-adapter.ts`
  - 负责流式卡片创建、流式更新、关闭流式、最终更新
  - 负责 `card.action.trigger` 事件的分流：`perm:` 入队，`diag:` 只记录诊断
  - 负责日志打点：`create-card`、`send-card-message`、`stream-content`、`close-stream`、`final-update`
- `markdown/feishu.ts`
  - 统一 schema 2.0 卡片 builder
  - 提供普通卡、流式初始卡、最终卡、权限卡 builder
  - 流式阶段用临时 `💭 Thinking...` 占位，文本恢复后自动移除；最终卡只保留正文顺序与 footer
- `adapters/feishu-cardkit.ts`
  - 统一 domain 解析
  - 统一 CardKit v1 的 create/settings/update payload 形状

## 权限要求

需要以下飞书权限：

- `im:message:send_as_bot`
- `im:message`
- `cardkit:card:write`

若缺权限：

- 普通卡片 / 权限卡片失败时回退到 post 或 text
- 流式卡片失败时回退到普通最终消息

## 本地诊断

根仓库提供本地脚本：

```bash
npm run feishu:card:test -- --mode all
```

支持模式：

- `static`
- `stream`
- `permission`
- `all`

默认行为：

- 读取当前 `config.env` 中的飞书配置
- 自动选择最近更新的活跃飞书绑定作为目标 chat
- 直接发送静态卡、流式卡、诊断权限卡到该会话
- 流式诊断卡收尾时会保留按时间顺序排列的正文与事件流，而不是替换成总结页
