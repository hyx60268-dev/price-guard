# price-guard 系统诊断

诊断基线：`8cb2188f8b7a2c6831f301b1058bbab64e8a3d36`，2026-09-27。诊断期间未修改仓库代码。

## 架构与数据流

根目录 Node ESM 项目，Playwright、Sharp、ExcelJS；静态 HTML/JS 仪表盘与 Service Worker。`price_guard_work/` 是旧副本，Actions 不运行它，但默认 `node --test` 会收集其测试。

没有独立数据库、常驻业务 API 或 SQL 事务。实际数据流：浏览器按用户保存 localStorage → AES-GCM 加密同步载荷 → 用户提交 GitHub Issue → Actions 使用 GitHub REST API 读取队列 → sync-input 合并 state/latest.json.enc → scan 访问 Yahoo/Rakuma/闲鱼 → publish 生成完整 state.json.enc、精简 latest.json.enc、分用户密文、Excel 与公开 status.json → Actions Cache 持久化 → Pages 部署 → 前端每分钟读 revision 并解密刷新。

## 已执行验证

- 完整克隆及历史读取；列出 2026-09-20 起 63 个提交，重点追踪状态、发布、扫描和匹配修改。并非每个历史版本均做过线上重跑。
- 安装依赖。普通 npm ci 与 Node 子进程受到当前 Windows 环境 EPERM 限制；使用工作区缓存及 ignore-scripts 安装后，现有测试以单进程运行：192 项，191 通过，1 项在创建符号链接时受权限限制。不能将这项当作业务逻辑失败。
- 启动原有 serve 服务，首页 HTTP 200。
- 实际读取 Yahoo 商品 z693328940：OPEN、详情正文存在、5 张图片、96 条推荐。说明 Yahoo 来源没有整体失效；不代表全量比价成功。
- 读取 Actions 36323137623 / job 108630909917 日志：扫描、部署成功，最后闲鱼验收失败。
- 读取真实 Pages status：代码版本仍为 8aab8d7，628 件，Yahoo 本轮实查 49 件、延后 579 件；按当前规则累计检查 199 件、429 件未覆盖。Rakuma 当前轮零成功，日志 HTTP 403。闲鱼尝试 1 件、login_required、零核验参考。

## 根因、优先级与拟修改文件

|问题|证据与根因|优先级|拟修改文件|
|---|---|---|---|
|同步破坏完整基准|cloud-sync 把 public/data/latest.json.enc 复制回 state；46f6e9c 将前者改为精简数据，遗漏修改此工作流；核验版本、样本证据、缓存 evidenceStatus 等丢失|P0|.github/workflows/cloud-sync.yml、发布回归测试|
|同步请求在中断时丢失|process-sync-queue 在上传/缓存/部署前关闭 Issue；此后失败或 push 取消，下一轮仅取 open Issue，无法恢复尚未持久化输入|P0|scripts/process-sync-queue.mjs、发布后确认脚本、相关工作流|
|多个发布者互相覆盖|price-guard/cloud-sync 用 pages 组；46f6e9c 新增 dashboard-repair 用另一组，恢复旧快照后能覆盖更新部署；push 还会取消正在运行的扫描|P0|三个发布工作流|
|账号旧值/删除复活|sync-input 未按 updatedAt 比较账号修改，删除直接 Map.delete；restore 会合并缓存中旧账号；前端 cloudManaged 后追加 local，无条件本地优先|P1|scripts/sync-input.mjs、scripts/lib/state.mjs、public/app.js、共享状态模块|
|新账号不立即扫描|cloud-sync 只发布 pending_sync，无扫描步骤或 dispatch；需等定时队列，且队列可能被替换|P1|.github/workflows/cloud-sync.yml、同步输出/触发脚本|
|重新上架成本不稳定|scan 每次重建 relistAliases，只比较上一轮仍在售 items 和静态 catalog；动态商品售出一轮后原身份消失。成本稳定键还优先采用搜索词，可碰撞不同颜色/数量；同名歧义未在成本查找层统一控制|P1|scripts/scan.mjs、scripts/lib/planner.mjs、scripts/lib/state.mjs、public/app.js、共享成本模块|
|Yahoo 更新慢/旧结果|18 分钟预算与全局请求限速；数百件库存每轮只覆盖部分；扫描结果等待25分钟选品任务后才保存发布，push 取消会丢进度|P1|price-guard.yml、scan.mjs、扫描覆盖与调度测试|
|Yahoo 空库存不更新|discoverYahooProfile 不返回 complete，scan 对空数组继续沿用旧清单，最后一件售出后仍残留|P1|scripts/lib/yahoo.mjs、主页回归测试|
|前端静默旧页面|普通数据刷新不检查前端构建版本；sw 只在打开时 update；刷新异常 catch 吞掉，账户合并本地优先|P1|public/app.js、public/sw.js、scripts/lib/publish.mjs|
|颜色/单套/端盒错误边界|已有共享硬约束和真实案例；数量语义仍取全文数字最大值，颜色检查只覆盖前两行与带标签的属性行，文本缺失不等于同款。需要具体链接区分旧缓存与新算法错误|P1|scripts/lib/rules.mjs、offer-identity.mjs、匹配回归用例|
|不同图误判/同首图漏判|多图比较取所有图组合最大值，公共背图可能拉高分；严格首图阈值只覆盖部分品类。视觉召回只给推荐流前20张机会，详情最多8条，搜索流弱标题没有相同视觉补召回。保留硬约束，不以降阈值解决|P1|scripts/lib/yahoo.mjs、image.mjs、回归用例|
|闲鱼自动成本失败|生产日志 Cookie 22 个、5 个过期；详情 login_required 后共享熔断，停止剩余检查；不能证明恰是哪一个过期 Cookie 导致。会话加载、详情可读、同款多卖家核验是不同阶段|外部授权阻塞|保留登录验证与熔断；有效授权后需重新云端验收|

## 近期提交相互作用

- **确认回归**：46f6e9c 引入轻量 dashboard payload，却遗漏 cloud-sync 的回写路径。已有针对 writeOutputs 的测试没有执行整条 YAML 工作流。
- **确认并发缺口**：同一提交引入独立 dashboard-repair 并发组，破坏原本串行发布的假设。
- **确认行为变化**：de3f84f 将成本计算从人工优先改为自动参考优先；scan 注释仍称人工成本 authoritative。记录本身未删除，但金额可能切换。该策略需要明确产品口径，不能把它伪称数据删除。
- **预期失效不是代码回退**：匹配规则与闲鱼核验版本升级会让旧自动证据不能复用；若来源被阻塞且全量扫描未完成，用户看到的数据会长期不完整。人工成本不应随版本失效。
- 8e3de19 强制全量审查与 8aab8d7 恢复普通轮转改变覆盖速度；新配置不等于已发布状态。最新 Rakuma 403 修复不能仅凭提交标题判定线上已恢复。
- 已有颜色、数量、图片回归案例仍存在并通过。尚无证据证明所有历史修复被整体覆盖；不能把用户列出的每个现象都归因于某次回滚。

## 高风险与验收边界

1. 队列确认必须在完整状态成功发布后；重试应幂等，失败请求不能丢弃。
2. 账号删除必须保留时间戳墓碑，权限检查不可因去重或重新绑定而放宽。
3. 成本迁移必须同账号、唯一商品身份，颜色/数量不同不能复用通用搜索词；保留旧记录以便人工找回。
4. 云端无有效闲鱼授权时不能承诺恢复成本，也不能拿搜索卡片价格替代详情实价。
5. 本地没有生产解密密码，无法读取实际人工成本/员工私有载荷。用隔离合成状态复现写入与恢复路径，不推断具体丢失记录。
6. 完整线上发布与修改 Secrets 不在此次本地诊断的验证证据内；修复后需区分本地测试、已提交代码和线上恢复。

## 修复顺序

先修状态/队列/发布事务边界；再修账号合并、首次扫描、历史商品与成本；最后修匹配边界和刷新可观测性。每组增加可重放回归并运行已有测试。实际修复与验证结果另附记录。
