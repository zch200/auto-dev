# Add Math Utilities and Calculator

## Phase 1: Add math utilities

Create a `src/math.ts` module with basic arithmetic functions.

Requirements:
- `add(a: number, b: number): number` — returns a + b
- `subtract(a: number, b: number): number` — returns a - b
- `multiply(a: number, b: number): number` — returns a * b

Add tests in `src/math.test.ts` covering each function with at least 2 test cases.

### Acceptance Criteria

1. `src/math.ts` exports `add`, `subtract`, and `multiply` functions
2. `src/math.test.ts` contains tests for all three functions
3. All existing tests continue to pass
4. TypeScript compilation passes with no errors

## Phase 2: Add calculator module

Create a `src/calculator.ts` module that **imports from `./math.js`** and provides a higher-level calculation interface.

Requirements:
- `calculate(a: number, b: number, op: 'add' | 'subtract' | 'multiply'): number` — delegates to the corresponding function from `math.ts`
- Throw an `Error` for unknown operations

Add tests in `src/calculator.test.ts` covering each operation and the error case.

### Acceptance Criteria

1. `src/calculator.ts` imports from `./math.js` and exports a `calculate` function
2. `src/calculator.test.ts` contains tests for add, subtract, multiply operations and the error case
3. All existing tests (including math tests from Phase 1) continue to pass
4. TypeScript compilation passes with no errors
