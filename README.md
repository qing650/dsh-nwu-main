HEAD
# 西北大学教务知识问答系统

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

面向校内师生选课、成绩、考试、学籍等教务咨询场景，开发教务处知识问答系统，解决信息分散、检索繁琐、人工答疑效率低等问题，提升教务信息查询效率与服务质量。

本项目在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区插件与二次开发工程基础上重构：

- 默认加载一套“西北大学教务问答示例知识库”，涵盖新生选课、成绩更正、缓考、重修/补修、专业准入、休学复学、考试纪律与学位授予等条目。
- 保留“来源收录 → 草稿审核 → 确认发布 → 热更新检索”的知识维护链路，便于把教务处原文和 FAQ 逐步沉淀为可审核、可追溯的知识图谱。
- 保留“知识缺口”闭环：问答助手答不上来的问题自动登记，知识维护模式按被问次数补齐资料并逐条销掉。

> [!IMPORTANT]
> 本演示知识库由公开网页资料的要点整理生成，不是教务处官网全文，也不代表西北大学官方发布。正式使用前应由教务管理人员逐条核对政策版本、学年适用范围与官方链接。

## 与 DeepSeek Harness 的关系

本项目沿用 DeepSeek Harness 的 Cordis 插件体系，主要扩展包括：

- `dsh-georag`：SQLite 图数据库 + 词法检索 + 知识图谱扩展 + 增量图谱热更新服务。
- `dsh-nwu`：“知识维护”与“教务问答”两种 agent 模式的工具和提示词。
- `dsh-nwu-intake`：资料收录、知识图谱接口和浏览器页面插件。
- `presets` 与 `nwu.cordis.yml`：产品挂载配置（`office-qa` 为默认模式，`knowledge-build` 为知识维护模式）。

## 功能

- **教务问答**：只读正式知识库，支持关键词检索、图谱邻接扩展、条目全文读取。回答先给结论，再给步骤、材料与办理渠道。
- **知识维护**：收录 TXT、Markdown、PDF、Word、图片和常见数据文件，由模型生成草稿，人工确认后再发布。
- **Graph RAG 数据底座**：知识节点、wikilink 关系、向量嵌入、事件日志、来源正文都写入 `data/nwu.sqlite`，启动时从数据库重建图谱并做“词法 + 图谱 + 向量”融合检索。
- **版本意识**：示例条目区分 2025 版学籍规定（适用于 2025 级及以后）与往年通知示例，避免跨年级误用。
- **知识缺口闭环**：问答中未被覆盖的问题自动进入待补清单，知识维护完成后逐条销掉。
- **知识图谱 / 知识星系**：二维交互图谱与三维星系视图，支持按“政策文件、办事指南、常见问题、通知公告、名词解释”筛选。
- **本地持久化**：来源、草稿、发布记录与知识缺口分开保存，重启可恢复。
- **权限隔离**：教务问答没有资料写入和发布工具，只能登记缺口。

## 运行环境

- Windows 10/11；Node.js 24 或 22.19+
- pnpm
- Python 3.11（用于 PDF/Word 等文件提取）

```powershell
.\安装教务问答.bat
.\启动.bat
```

安装后打开：

- 主界面：`http://127.0.0.1:3080/`
- 知识图谱：`http://127.0.0.1:3080/nwu/knowledge-graph`
- 知识星系：`http://127.0.0.1:3080/nwu/knowledge-galaxy`

首次使用请在“设置 > 模型”中配置模型与 API Key。凭据仅写入本机 DSH 配置。

## 使用流程

### 配置模型并进入教务问答

启动后默认进入“教务问答”。可以问：

- 新生选课什么时候开始？选课系统怎么登录？
- 错过选课或者漏选课程怎么办？
- 成绩有疑问怎么申请更正？
- 缓考怎么申请？考前忘了申请直接缺考会怎样？
- 必修课不及格怎么重修？及格后还能再刷分吗？

### 维护知识库

切换到“知识维护”，可选择教务文件总文件夹或直接粘贴文本。发送“处理最新资料”后，系统读取来源并生成草稿。

草稿不会自动发布，确认无误后发送：

```text
确认发布 draft-xxxxxxxx
```

发布成功后检索会立即更新。每份草稿都应写明政策版本、适用年级和来源链接。

## 数据结构

基础知识由 `data/*.json` 导入，启动后统一落入 **SQLite 图数据库 `data/nwu.sqlite`**：

```text
data/nwu.sqlite
├─ graph_nodes    知识节点（基础 + 已发布）
├─ graph_edges    知识关系边
├─ node_embeddings  768 维本地哈希向量嵌入
├─ source_files   来源正文与原件
└─ events         草稿/发布/知识缺口事件日志
```

基础 JSON 由以下脚本生成，用于向 SQLite 导入/刷新基础图谱：

```powershell
python tools\build_nwu_demo.py config\nwu.json
```

运行期间新增的资料、草稿、发布记录与知识缺口写入 `data/nwu.sqlite`（已在 `.gitignore` 中），不再依赖 JSONL 事件文件。旧庐山地理数据与误入库的遥感资料已归档到本机 `data/legacy-backup/`，不会随项目启动加载。

向量嵌入默认使用 `tools`/`dsh-georag` 内置的本地哈希嵌入（768 维，无需下载模型），可替换为外部 Embedding API。

## 多路检索消融评测

```powershell
node tools\eval_rag_methods.mjs
```

评测分别运行纯词法、纯图谱、纯向量、两两组合和全量融合配置，结果写入：

- [评测/eval_rag_vector_report.md](评测/eval_rag_vector_report.md)
- [评测/eval_rag_vector_results.json](评测/eval_rag_vector_results.json)
- [评测/eval_rag_vector_results.csv](评测/eval_rag_vector_results.csv)

若需要重新构建旧地理现场数据，可保留 `tools/build_data.py` 与 `config/lushan.json` 手动执行：

```powershell
python tools\build_data.py config\lushan.json
```

## 示例知识库来源

演示条目的正文末尾均带有官方来源链接。主要公开资料：

- [2026—2027学年第一学期本科新生选课通知（教务处）](https://jwc.nwu.edu.cn/info/1034/11158.htm)
- [2025—2026学年第一学期本科生选课通知（学校主页）](https://www.nwu.edu.cn/info/1093/8127.htm)
- [2025—2026学年第二学期重修、补修、免听报名通知（学校主页）](https://www.nwu.edu.cn/info/1093/20286.htm)
- [西北大学本科生学籍管理规定（2025版）（信息公开网）](https://xxgk.nwu.edu.cn/info/1078/1736.htm)
- [成绩更正流程（教务处）](https://jwc.nwu.edu.cn/info/1023/8491.htm)
- [期末考试安排与考风考纪（教务处）](http://jwc.nwu.edu.cn/info/1034/11121.htm)
- [专业准入申请通知（学校主页）](http://www.nwu.edu.cn/info/1093/20961.htm)
- [西北大学学士学位授予实施细则（信息公开网）](https://xxgk.nwu.edu.cn/info/1085/1110.htm)

## 项目结构

```text
presets/                  知识维护与教务问答两个 DSH preset
dsh-georag/               SQLite 图数据库、图谱检索与增量热更新插件
dsh-nwu/              两种模式的工具注册与系统提示词
dsh-nwu-intake/       资料收录、图谱接口和图谱/星系页面插件
deepseek-harness-master/  项目内定制的 DeepSeek Harness 源码
tools/                    数据构建、资料提取和验收脚本
web/                      独立问答界面源码及检索评测复用代码
data/                     教务演示基础数据（运行时知识写入 knowledge/）
```

## 许可与声明

项目代码使用 [MIT License](LICENSE)。DeepSeek Harness 的原始 MIT 许可证、版权声明和第三方依赖声明保留在 `deepseek-harness-master/deepseek-harness-master/`，汇总信息见 [NOTICE.md](NOTICE.md)。

本项目不是西北大学官方软件。示例知识正文仅用于演示系统能力，引用公开网页时请以官网原文为准。

