# v2.1.0 开发计划

## Phase 1: 数据库 Schema 变更
新增 xxx 表，修改 yyy 字段

### 验收标准
- 新增了 migrations/001_add_xxx.sql 文件且包含 CREATE TABLE 语句
- 现有测试不受影响

## Phase 2: 后端 API 开发
实现 REST API 接口

### 验收标准
- GET /api/xxx 返回正确数据
- 编写了单元测试
