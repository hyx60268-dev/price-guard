# 价格守卫 v2（Yahoo!フリマ × 闲鱼）

这一版把 Yahoo 与闲鱼彻底拆开：

- **Yahoo 默认不登录**。卖家主页和站内搜索只按公开页面读取，不再需要 `YAHOO_STORAGE_STATE_B64`。
- **多账号**。账号清单放在 `config/accounts.json`，每个账号有独立的 `config/catalogs/<id>.json` 商品清单。
- **主页刷新失败不清空**。自动刷新失败时继续使用该账号上次确认的商品清单。
- **前端账号下拉框**。页面可切换不同 Yahoo 账号。
- **网页“账号管理”**。可以直接粘贴 Yahoo 卖家主页并保存在当前浏览器 `localStorage`。这种新增账号是“本机记忆”，不会自动写回 GitHub；页面可一键复制 Work 同步配置，后续让 Work 写回 `config/accounts.json` 即可。
- **闲鱼单独登录**。闲鱼失效不会阻断 Yahoo；成本有历史缓存就沿用，没有就留空。
- **详细日志**。Yahoo 或闲鱼实时抓取失败时，GitHub Actions 会打印状态和错误，不再静默吞掉。

## 账号配置

`config/accounts.json`：

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "melon",
      "name": "メロン",
      "platform": "yahoo_fleamarket",
      "profileUrl": "https://paypayfleamarket.yahoo.co.jp/user/p76217154",
      "catalogFile": "config/catalogs/melon.json",
      "enabled": true
    }
  ]
}
```

卖家主页链接使用账号 ID 型 URL，一般可长期保存。若 Yahoo 改版或账号迁移，只需更新 `profileUrl`。

新增第二个账号时：

1. 在 `config/accounts.json` 增加一条；
2. 复制一个现有 catalog 为 `config/catalogs/<新id>.json`；
3. 后续 Work 可打开新账号主页、抓取全部当前在售商品并覆盖该 catalog。

网页里的“账号管理”适合先保存主页链接。它不需要 GitHub 写权限，因此不会泄露 GitHub token。

## GitHub Secrets

现在只需要：

- `DASHBOARD_PASSWORD`：至少 8 位；
- `XIANYU_AUTH_PART_1`
- `XIANYU_AUTH_PART_2`
- `XIANYU_AUTH_PART_3`

兼容旧的 `XIANYU_STORAGE_STATE_GZIP_B64` / `XIANYU_STORAGE_STATE_B64`，但建议使用三段 Secret。

**不再需要 `YAHOO_STORAGE_STATE_B64`。**

## 重新生成闲鱼登录 Secret

电脑安装 Node.js 20+ 后，在项目目录运行：

```bash
npm install
npx playwright install chromium
npm run login
```

程序只打开闲鱼。完成登录并确认能正常搜索商品后，回到终端按回车。会生成：

- `.auth/XIANYU_AUTH_PART_1.txt`
- `.auth/XIANYU_AUTH_PART_2.txt`
- `.auth/XIANYU_AUTH_PART_3.txt`

分别复制到 GitHub：

`Settings → Secrets and variables → Actions → Repository secrets`

然后进入：

`Actions → 每日价格检查 → Run workflow`

## Work 预留接口

未来让 ChatGPT Work 做实时同步时，目标很简单：

1. 读取 `config/accounts.json`；
2. 对每个 `profileUrl` 打开公开 Yahoo 主页；
3. 获取当前全部在售商品；
4. 保留已有 `xianyuQuery`、`size`、历史确认字段；
5. 写回对应 `config/catalogs/<id>.json`；
6. 提交后触发 GitHub Actions。

网页“账号管理 → 复制 Work 同步配置”会生成适合交给 Work 的账号 JSON。

## 状态说明

仪表盘会分开显示：

- Yahoo主页：实时成功 / 使用保存清单；
- Yahoo比价：多少件拿到实时结果；
- 闲鱼成本：实时 / 缓存 / 无成本；
- Work接口：已预留。

因此闲鱼过期不会再让 Yahoo 部分一起看起来“全坏了”。

## 现实限制

Yahoo 和闲鱼都可能对 GitHub Actions 的云端浏览器做风控，或更改页面结构。公开主页不要求 Yahoo 登录，但不等于一定允许 GitHub 云端环境稳定读取。遇到这种情况，系统会保留 catalog，不会删除商品；以后可以由 Work 在真实浏览器环境中刷新 catalog。
