# Add Capitalize Utility

## Phase 1: Add capitalize function

Create a `capitalize` utility function in `src/capitalize.ts`.

Requirements:
- `capitalize(str)` returns the string with the first letter uppercased and the rest lowercased
- Handle empty string input (return empty string)
- Handle single character input

Add tests in `src/capitalize.test.ts`.

Important: This project uses pnpm. Use `pnpm install` (not npm) to install dependencies.

### Acceptance Criteria

1. `src/capitalize.ts` exports a `capitalize(input: string): string` function
2. `src/capitalize.test.ts` contains tests for normal strings, empty string, and single character
3. All existing tests continue to pass
4. TypeScript compilation passes with no errors
