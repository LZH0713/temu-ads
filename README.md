# Temu Ads ROAS Helper

一个 Manifest V3 浏览器扩展，用于在 Temu Ads 推广列表页读取商品/SPU ID、拉取最低活动价、手动维护成本价，并计算回本 ROAS。

## 安装

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展”，选择本目录：`/Users/liangzhihong/Code/temu-ads`。
4. 打开 Temu Ads 推广列表页，点击扩展图标配置 API 和选择器。

扩展会优先在推广列表表格的“预算和出价”列后插入 5 列：

- 最低活动价
- 成本价
- 目标ROAS
- 回本ROAS
- 判断

如果页面不是这种表格结构，则会退回到在商品行尾插入紧凑面板。

## 本地验证

```bash
npm test
```

## 计算逻辑

回本广告费：

```text
最低活动价 - 成本价
```

回本 ROAS：

```text
最低活动价 / 回本广告费
```

如果活动报名接口没有返回活动价，扩展会显示“无活动价”，并改用页面里的最低申报价计算：

```text
最低申报价 / (最低申报价 - 成本价)
```

判断：

```text
目标 ROAS > 回本 ROAS => 达标
```

如果成本价大于或等于最低活动价，会显示“成本过高”。

## 价格接口

价格来源固定为 Temu 活动报名接口：

```text
https://agentseller.temu.com/api/kiana/gamblers/marketing/enroll/list
```

扩展会用当前 Temu 页面登录态请求：

```json
{"pageNo":1,"pageSize":10,"productIds":[9401217708]}
```

解析规则：

- `result.list[].productId` 匹配页面里的 SPU/商品 ID。
- 优先只读取 `sessionStatus=2` 的进行中活动。
- 从 `skcList[].skuList[].activityPrice` 读取最低活动价。
- `activityPrice` 单位按分处理，例如 `11700 => 117.00`，`12711 => 127.11`。

如果 Temu 接口返回 403 或需要风控头，可以在弹窗里填 `Mall ID` 和 `anti-content`。`anti-content` 通常会过期，建议从当前登录页面的网络请求里复制最新值。

为了让请求带上 Temu 的同源登录态，建议同时打开并保持一个 `https://agentseller.temu.com/` 页面（例如活动报名记录页）。扩展会优先把价格请求转发给这个页面执行；找不到该页面时才退回后台跨域请求。

## DOM 选择器

如果默认扫描识别不到 Temu 页面结构，可以在弹窗里配置：

- 行选择器：每个推广商品行，例如 `.table-row`。
- SPU 选择器：在行内读取 SPU ID 的节点，例如 `.spu-id`。
- 目标 ROAS 选择器：在行内读取目标 ROAS 的节点，例如 `.target-roas`。

选择器留空时，扩展会在页面内按 `SPU ID`、`SPU`、`商品ID` 等文本特征自动识别。

## 成本价

成本价可以在页面插入的输入框里逐个填写，也可以在弹窗中批量维护：

```text
123456789=18.5
987654321=22
```
