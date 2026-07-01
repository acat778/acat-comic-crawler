# JMComic-Crawler-Python 下载速度研究

> 研究日期：2026-06-30
> 参考项目：https://github.com/hect0x7/JMComic-Crawler-Python
> 目的：理解其下载架构，为后续优化提供方向

## 速度对比

| 维度 | JMComic-Crawler-Python | 我们的 Node.js 爬虫 |
|---|---|---|
| 图片并发数 | 30 张同时下载 | 逐张串行下载 |
| 章节并发数 | CPU 核数（~8-16） | 逐章节串行 |
| 图片间延迟 | 无 | `await sleep(500)` |
| HTTP 连接 | Session 复用 TCP 连接 | 每请求独立 |
| 元数据请求 | 3 个 API 调用并行 + 去重 | 串行调用 |
| 缓存 | 三级缓存（内存/Option/Client） | 无 |

**以 10 章 × 30 图 = 300 张图片估算：**

- Python 版：30 线程并发 → 约 30-60 秒
- 当前：300 × (下载耗时 + 500ms sleep) → **至少 7-8 分钟**

## 核心架构

### 1. 四级并发

```
专辑级 → 批量下载多个专辑（parallel）
  └─ 章节级 → decide_photo_batch_count（默认 CPU 核数）
       └─ 图片级 → decide_image_batch_count（默认 30）
            └─ 元数据级 → PhotoConcurrentFetcherProxy
```

`execute_on_condition` 自适应策略：
- 小批量：`multi_thread_launcher`（每任务一线程，无池开销）
- 大批量：`thread_pool_executor(max_workers=count_batch)`

### 2. 线程配置

```yaml
download:
  threading:
    image: 30          # 单章并发图片数
    photo: null         # 单专辑并发章节数，默认 cpu_count()
  cache: true           # 跳过已存在文件
```

最大并发线程数 ≈ `专辑数 × photo_batch × image_batch + proxy_workers`
（例：3 × 5 × 10 + 3 = 153 线程）

### 3. PhotoConcurrentFetcherProxy

原始 `get_photo_detail` 需要 3 次串行调用：
1. 获取章节详情
2. 获取专辑详情
3. 获取 scramble_id

Proxy 将其并行化，并使用 `future_dict + threading.Lock` 去重：
- 3 线程同时请求同一章节 → 9 次 API 调用 → 去重后仅 3 次
- 生命周期与 client 一致，使用长生命周期 ThreadPoolExecutor

### 4. 三级缓存

| 级别 | 作用域 | 效果 |
|---|---|---|
| `@field_cache` | 方法级（实例属性） | 首调用缓存，后续 <1ms |
| `level_client` | 单客户端实例 | 每 client 独立缓存 |
| `level_option` | 所有 client 共享 | 搜索/详情 150-500x 加速 |

scramble_id 双重索引（photo_id + album_id），同一专辑只请求一次。

### 5. HTTP 层优化

- **curl_cffi**：TLS 指纹伪装 Chrome，绕过 Cloudflare 不触发额外质询
- **Session 复用**：`Postman.session` 保持 TCP 连接
- **多域名故障转移**：失败自动换域名，最多 5 次重试
- **响应校验**：非 JSON 响应立即重试，不浪费等待

### 6. 磁盘缓存

```python
if image.exists and image.cache:
    return  # 文件已存在，跳过
```

仅一次 `file_exists` 检查即跳过已下载内容。

## 后续优化方向（按收益排序）

| 优先级 | 优化项 | 预期提升 | 复杂度 |
|---|---|---|---|
| P0 | 去掉 `sleep(500)` | 300 张图省 150 秒 | 低 |
| P0 | 图片并发下载（10-20 并发） | 5-10x | 中 |
| P1 | 章节级并行处理 | 10 章省 ~80% 时间 | 中 |
| P1 | HTTP keep-alive（复用 axios 实例） | 减少 TLS 握手 | 低 |
| P2 | 元数据缓存（album/chapter info） | 避免重复 API 调用 | 低 |
| P2 | scramble_id 同专辑复用 | 减少额外请求 | 低 |
| P3 | curl_cffi 等价方案（TLS 指纹） | 稳定性提升 | 高 |

### 关于 sleep(500) 的说明

当前代码中的 `await sleep(500)` 位于 `src/services/crawler.js`：

- API 路径（第 334 行）：每张图上传到后端后等待 500ms
- 浏览器路径（第 494 行）：同上

这个延迟可能是为了：
1. 避免后端服务过载
2. 避免触发 JMComic 的速率限制

**后续优化时需要考虑：**
- 后端批量上传接口（一次上传多张图），消除逐张等待
- JMComic 下载并发数与速率限制的平衡点
- 用指数退避重试替代固定 sleep

## 参考资料

- JMComic-Crawler-Python: https://github.com/hect0x7/JMComic-Crawler-Python
- 并发优化文档: https://deepwiki.com/hect0x7/JMComic-Crawler-Python/6.7-concurrent-download-optimization
- 缓存策略: https://deepwiki.com/hect0x7/JMComic-Crawler-Python/6.4-caching-strategies
- 配置选项: https://deepwiki.com/hect0x7/JMComic-Crawler-Python/4.2-configuration-options
