# 价格守卫 v4（Yahoo!フリマ × 闲鱼）

价格守卫在 GitHub Actions 云端运行，电脑和手机都可以关机。系统约每 20 分钟检查一次 Yahoo!フリマ 当前在售商品和同款最低价；只有自己的售价高于已确认同款最低价时，才继续搜索闲鱼成本。

## v4 的主要变化

- **费用全部改为手工确认**：系统不再按小/中/大猜测人肉费或日本物流费。
- **每件商品有 3 个输入框**：采购价（人民币）、人肉费（人民币）、日本物流费（日元）。
- **利润即时重算**：保存后自动计算成本、当前利润、调价后利润和 ¥1,500 预警。
- **手工数据可保存**：默认保存在当前浏览器；账号管理中可导出/导入 JSON，在手机和电脑之间迁移。
- **Excel 可直接填写**：黄色三列为手工输入，成本与利润使用 Excel 公式自动计算。
- **先同步库存差异**：读取 Yahoo 主页后只识别新增、减少和继续在售，继续在售商品复用已有搜索词和元数据。
- **闲鱼按需运行**：Yahoo 比价确认需要降价时才搜索闲鱼，大多数商品会跳过闲鱼步骤。
- **低价钩子保护**：闲鱼候选必须通过卡片标题、图片和商品详情二次核验；选款、改价、补差、多规格/多角色商品会被排除。
- **价格聚类**：至少 2 个详情验证一致、价格处于同一合理区间的样本才生成自动均价；否则要求人工填写采购价。
- **旧缓存作废**：v3 只看搜索卡片产生的闲鱼均价不会被 v4 沿用，避免旧的低价钩子继续影响利润。
- **多账号入口保留**：每个 Yahoo 账号使用独立 catalog，页面可切换账号。

## 计算公式

    成本 = ((采购价人民币 + 人肉费人民币) × 人民币兑日元汇率 + 日本物流费日元) × 1.05

最终结果向上取整。采购价输入框留空时，仅在闲鱼已有可靠验证均价的情况下使用该均价；人肉费和日本物流费始终由用户填写。

## 扫描流程

1. 读取每个 Yahoo 卖家主页，只保留 OPEN 商品；
2. 与上次加密基准比较，识别新增和减少；
3. 继续在售商品复用 catalog/上次结果里的闲鱼搜索词等元数据；
4. 对当前在售商品逐件做 Yahoo 同款最低价检查；
5. 自己已经最低时跳过闲鱼；
6. 自己价格更高时才搜索闲鱼，并进入候选详情核验；
7. 加密生成仪表盘和 Excel；
8. 与上次结果有变化时发送手机提醒。

Yahoo 搜索仍保持单通道限速，以降低云端 IP 被 429 限流的概率。GitHub 的定时任务可能有数分钟排队延迟，因此“每 20 分钟”是云端计划频率，不承诺精确到秒。
若上一轮尚未完成，新一轮会排队而不会取消已完成大半的扫描。

## 手机使用和通知

仪表盘：

<https://hyx60268-dev.github.io/price-guard/>

- iPhone：用 Safari 打开，选择“分享 → 添加到主屏幕”。
- Android：用 Chrome 打开，选择“安装应用”或“添加到主屏幕”。
- 页面右上角的“手机与通知”也包含完整说明。

默认通知通过 GitHub Issue：

1. 安装 GitHub 手机 App；
2. 打开本仓库；
3. 选择 Watch → Custom → Issues；
4. 在手机系统设置中允许 GitHub 通知。

历史提醒：

<https://github.com/hyx60268-dev/price-guard/issues>

通知只包含变化数量和仪表盘链接，不公开商品成本或利润。若设置了 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID，系统会优先发送 Telegram 私聊。

## 手工成本保存范围

网页是静态加密仪表盘，不能安全地把 GitHub 写入令牌放在浏览器里。因此手工成本默认保存在浏览器 localStorage：

- 同一设备、同一浏览器再次打开仍会保留；
- 清理网站数据会删除；
- 手机和电脑之间不会自动同步；
- 可在“账号管理 → 手工成本备份”导出 JSON，再在另一台设备导入。

仓库是公开的，手工成本不会明文提交到仓库。

## 多账号配置

config/accounts.json：

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

新增账号时：

1. 在 config/accounts.json 增加账号；
2. 创建 config/catalogs/<账号ID>.json；
3. 填入商品初始搜索词；之后库存增减会按账号独立检测。

## GitHub Secrets

必需：

- DASHBOARD_PASSWORD：至少 8 位；
- XIANYU_AUTH_PART_1
- XIANYU_AUTH_PART_2
- XIANYU_AUTH_PART_3

兼容旧的 XIANYU_STORAGE_STATE_GZIP_B64 / XIANYU_STORAGE_STATE_B64。Yahoo 使用公开页面，不需要 Yahoo 登录 Secret。

可选：

- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID

## 重新生成闲鱼登录 Secret

电脑安装 Node.js 20+ 后，在项目目录运行：

    npm install
    npx playwright install chromium
    npm run login

完成闲鱼登录并确认可以搜索后回到终端按回车。程序会生成三个分段文件，分别复制到 GitHub：

Settings → Secrets and variables → Actions → Repository secrets

即使闲鱼登录失效，Yahoo 库存和价格检查仍会继续；需要降价但无法可靠搜索闲鱼的商品会显示人工采购价输入框。

## 仓库说明

仓库根目录是唯一运行版本。旧的 price_guard_work/ 是历史上传副本，不参与当前 GitHub Actions。
