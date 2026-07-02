# VCP 分布式服务器节点 / 官方插件商店

本项目是一个为 VCP (Variable & Command Protocol) 生态系统设计的独立服务器节点，同时也是 VCP 官方插件商店仓库。

作为分布式服务器节点时，它允许您通过在不同的机器上运行插件，来扩展您的主 VCP 服务器的能力和算力。

作为官方插件商店时，它会通过 `Plugin/` 目录内的 `plugin-manifest.json` 或初始禁用清单 `plugin-manifest.json.block` 自动生成单插件 ZIP 安装包和根目录 `plugins.json` Registry 索引，供 VCPToolBox 管理员面板按需下载、安装单个插件，而不是下载整个仓库。

## 1. 项目目的

本仓库具有两个核心用途：

1. **VCP 分布式服务器节点**：连接到一台主 VCP 服务器，并注册其本地的插件。主服务器随后便能透明地将工具执行请求委派给此节点。
2. **VCP 官方插件商店**：维护官方可分发插件集合，生成 `plugins.json` 商店索引和每个插件自己的 ZIP 包，供 VCPToolBox 以 Registry 源形式安装。

分布式节点机制非常适合以下场景：

-   **重型计算任务**: 将 GPU 或 CPU 密集型任务（如视频生成、大规模数据处理）卸载到专用的高性能机器上。
-   **访问特定资源**: 运行需要访问特定硬件或网络资源的插件（例如，内网的文件服务器、特殊的硬件设备）。
-   **可扩展性**: 创建一个由多个节点组成的网络，以分散工作负载，增强整个 VCP 系统的容量。

## 2. 工作原理

1.  **初始化**: 服务器启动，加载其 `Plugin` 目录下的所有有效本地插件。
2.  **连接**: 使用 `config.env` 中指定的 URL 和密钥，与主 VCP 服务器建立 WebSocket 连接。
3.  **注册**: 连接成功后，它会将其可用的插件清单发送给主服务器。主服务器会将这些插件注册为“云端插件”。
4.  **执行**: 监听来自主服务器的 `execute_tool` 命令。当收到请求时，它会使用提供的参数执行相应的本地插件。
5.  **返回结果**: 执行完毕后，通过 WebSocket 连接将结果（或错误信息）发回给主服务器。
6.  **自动重连**: 如果与主服务器的连接断开，它将采用指数退避策略自动尝试重新连接。

## 3. 官方插件商店

官方插件商店使用 Registry JSON + 单插件 ZIP 模式。

- 商店索引文件：`plugins.json`
- 插件目录：`Plugin/<PluginName>/`
- 插件清单：`Plugin/<PluginName>/plugin-manifest.json` 或 `Plugin/<PluginName>/plugin-manifest.json.block`
- 插件安装包：`Plugin/<PluginName>/<ManifestName>.zip`
- 官方 Registry 源地址：`https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json`

### 3.1 生成商店索引和插件 ZIP

在仓库根目录运行：

```bash
python scripts/build_plugin_store.py
```

如果仓库名或分支不同，可以显式指定：

```bash
python scripts/build_plugin_store.py --repo lioensky/VCPDistributedServer --branch main
```

脚本会：

1. 扫描 `Plugin/` 下一级子目录。
2. 打包包含 `plugin-manifest.json` 的启用插件。
3. 默认也打包仅包含 `plugin-manifest.json.block` 的初始禁用插件。
4. 当插件来源清单是 `plugin-manifest.json.block` 时，ZIP 内会自动写成 `plugin-manifest.json`，保证 VCPToolBox 安装器能递归识别。
5. 为每个插件生成独立 ZIP 包。
6. 生成根目录 `plugins.json`，其中每个插件条目使用 `downloadUrl` 指向对应 ZIP。

如需临时排除 `.block` 插件，可运行：

```bash
python scripts/build_plugin_store.py --exclude-blocked
```

### 3.2 在 VCPToolBox 中添加插件商店源

进入 VCPToolBox 管理员面板的“插件商店 / 源管理”，添加：

- 名称：`VCP 官方插件商店`
- 类型：`Registry (JSON 列表)` 或 `registry`
- URL：`https://raw.githubusercontent.com/lioensky/VCPDistributedServer/main/plugins.json`

添加后刷新插件市场，即可从本仓库安装官方插件。

## 4. 分布式节点安装与设置

### 前提条件

-   Node.js (推荐 v16 或更高版本)
-   一个正在运行的主 VCP 服务器实例。

### 步骤

1.  **安装依赖**:
    ```bash
    npm install
    ```

2.  **配置节点**:
    -   通过复制 `config.env.example` (如果提供) 或手动创建一个名为 `config.env` 的新文件。
    -   填写必要的变量：
        -   `Main_Server_URL`: 您的主 VCP 服务器的 WebSocket URL (例如, `ws://192.168.1.100:8088`)。
        -   `VCP_Key`: 必须与您主服务器 `config.env` 中的 `VCP_Key` 完全一致的密钥。
        -   `ServerName`: 为此节点起一个易于识别的描述性名称 (例如, `GPU节点-1号`)。
        -   `DebugMode`: 设置为 `True` 以在控制台获得更详细的日志。

3.  **添加插件**:
    -   在此项目文件夹内创建一个名为 `Plugin` 的目录。
    -   将您希望在此节点上运行的 VCP 插件文件夹（例如 `SciCalculator`）完整地复制到这个 `Plugin` 目录中。
    -   **重要提示**: 目前，分布式节点仅支持 `synchronous` (同步) 类型的、且通信协议为 `stdio` 的插件。

4.  **启动服务器**:
    ```bash
    node VCPDistributedServer.js
    ```

启动后，您应该能在控制台看到节点的连接状态和插件注册日志。您也可以在主 VCP 服务器的控制台中查看到此节点的连接和工具注册信息。

## 5. 仓库维护约定

- 新增可发布插件时，请将插件放入 `Plugin/<PluginName>/` 并提供有效的 `plugin-manifest.json`。
- 希望在仓库中保持初始禁用、但仍发布到插件商店的插件，可以保留 `plugin-manifest.json.block`；脚本默认会把它纳入商店，并在 ZIP 内转换为 `plugin-manifest.json`。
- 如果某次构建需要排除 `.block` 插件，可使用 `python scripts/build_plugin_store.py --exclude-blocked`。
- 发布前运行 `python scripts/build_plugin_store.py`，提交更新后的 `plugins.json` 与对应插件 ZIP。
- 不要在插件目录内提交敏感配置；脚本默认会排除 `config.env`、`.env`、`node_modules/`、`.venv/`、`__pycache__/` 等文件。
- 插件有 Node.js 依赖时提交 `package.json` 即可，VCPToolBox 安装器会在安装后按需执行依赖安装。