# Initialize Node.js TypeScript Project

## Phase 1: Bootstrap project

从零开始初始化一个 Node.js TypeScript 项目。

Requirements:
- 创建 `package.json`，设置 `"type": "module"`，添加 typescript 和 vitest 作为 devDependencies
- 创建 `tsconfig.json`，使用严格模式，target ES2022，module ESNext，moduleResolution bundler
- 创建 `vitest.config.ts`
- 创建 `src/index.ts`，导出一个 `add(a: number, b: number): number` 函数
- 创建 `src/index.test.ts`，测试 add 函数的基本用例
- 运行 `npm install` 安装依赖

### Acceptance Criteria

1. `package.json` 存在且包含 typescript 和 vitest 依赖
2. `tsconfig.json` 存在且配置了严格模式
3. `src/index.ts` 导出 `add` 函数
4. `src/index.test.ts` 包含 add 函数的测试
5. TypeScript 编译通过
6. 测试全部通过
