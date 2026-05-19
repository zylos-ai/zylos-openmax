# AS 操作指南

CLI 位置：`src/cli/as.js`
调用方式：`node src/cli/as.js <command> '<json>'`

## 命令列表

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `as.upload` | 上传文件到 AS | `{filePath, filename?, contentType?}` |
| `as.get` | 获取 Artifact 元数据 | `{artifactId}` |
| `as.url` | 获取 Artifact 访问 URL | `{artifactId, expiresIn?}` |
| `as.list` | 列出关联的 Artifact | `{issueId?}` 或 `{projectId?}` |

## AS vs KB 判断

- 能用 markdown 表达 → KB
- 二进制文件（图片、PDF、数据集） → AS
- 体积大（MB/GB 级） → AS
- 需要不可变引用的交付物 → AS

## 典型流程

```bash
# 上传产出文件
node src/cli/as.js as.upload '{"filePath":"/tmp/report.pdf","filename":"growth-q2.pdf"}'
# 输出: {"artifactId":"art-xxx","uri":"artifact://art-xxx"}

# 在 KB 的交付物索引中登记
node src/cli/kb.js kb.write '{"path":"/projects/growth/deliverables/q2-report.md","content":"# Q2 Report\n\n- [PDF](artifact://art-xxx)","commitMessage":"kb(growth): add Q2 report deliverable"}'
```

## 注意事项

- AS 是 blob 模式：上传 → 拿 URI → 按 URI 读取。不支持搜索、编辑、导航
- Artifact 不可变，"修改"等于新建
- 通过 KB deliverables 索引或 TM Artifact 关联来发现已有 Artifact
