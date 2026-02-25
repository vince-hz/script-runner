# script-runner

一个本地 HTTP 服务，用来执行 `scripts.json` 里预先配置的脚本，支持同步/异步任务。

## Quick Start

1. 准备 `config.json`（仓库已提供示例）。
2. 启动服务：

```bash
npm start
```

默认监听：`0.0.0.0:8080`

## 配置格式

`config.json`:

- `server.host`: 监听地址
- `server.port`: 监听端口
- `runner.maxConcurrent`: 最大并发执行数
- `runner.defaultMode`: 默认执行模式（`sync` 或 `async`）
- `runner.maxLogBytesPerStream`: 每个流（stdout/stderr）最大日志字节
- `runner.previewMaxBytes`: 在任务元数据里保留的日志预览长度（尾部）
- `runner.jobStoreFile`: 任务存储文件（重启后可查询历史）
- `runner.logsDir`: 任务日志目录
- `scriptsFile`: 脚本清单文件路径（相对路径相对于 `config.json`）

`scripts.json`:

- `scripts[]`: 可执行脚本白名单

脚本项（定义在 `scripts.json`）：

- `id`: 调用 ID（请求时用）
- `path`: 脚本路径（相对路径相对于 `scripts.json`）
- `mode`: 默认模式（`sync`/`async`）
- `timeoutSec`: 超时秒数；`0` 表示不主动超时
- `args.maxItems`: 参数个数上限
- `args.itemPattern`: 每个参数的正则
- `args.itemMaxLength`: 每个参数最大长度

## API

### `POST /run`

请求：

```json
{
  "scriptId": "quick-echo",
  "args": ["hello", "world"],
  "mode": "sync"
}
```

说明：

- `mode` 可选：`sync` 或 `async`
- 未传 `mode` 时，优先用脚本配置，其次用 `runner.defaultMode`

同步返回：HTTP `200` + 完整执行结果  
异步返回：HTTP `202` + `jobId`

### `GET /jobs/:jobId`

查询任务状态与元数据（包含 `stdoutPreview/stderrPreview`，不返回完整日志）。

### `GET /jobs/:jobId/logs?stream=stdout&offset=0&limit=65536`

按偏移分页读取完整日志内容。

### `POST /jobs/:jobId/cancel`

取消任务（队列中的任务会直接标记为 `canceled`；运行中的任务会发 `SIGTERM`）。

### `GET /healthz`

健康检查。

## 执行行为

- 当前执行器使用 `shell: true` 启动脚本。
- 子进程会继承服务进程的环境变量（`process.env`）。
- 这不等于“每次执行都自动加载交互 shell 配置”（如 `.zshrc`）；是否加载取决于你如何启动服务和脚本本身逻辑。

## curl 示例

同步执行：

```bash
curl -sS -X POST http://127.0.0.1:8080/run \
  -H 'content-type: application/json' \
  -d '{"scriptId":"quick-echo","args":["a","b"],"mode":"sync"}'
```

异步执行：

```bash
curl -sS -X POST http://127.0.0.1:8080/run \
  -H 'content-type: application/json' \
  -d '{"scriptId":"long-task","args":["20"],"mode":"async"}'
```

查询任务：

```bash
curl -sS http://127.0.0.1:8080/jobs/<jobId>
```

读取 stdout 日志（分页）：

```bash
curl -sS "http://127.0.0.1:8080/jobs/<jobId>/logs?stream=stdout&offset=0&limit=65536"
```

取消任务：

```bash
curl -sS -X POST http://127.0.0.1:8080/jobs/<jobId>/cancel
```

## 错误码

- `SCRIPT_NOT_FOUND`
- `INVALID_ARGS`
- `JOB_NOT_FOUND`
- `NOT_FOUND`
- `INTERNAL_ERROR`

## 兼容说明

- 如果未配置 `scriptsFile`，服务会回退读取 `config.json` 里的 `scripts[]`（向后兼容旧格式）。
