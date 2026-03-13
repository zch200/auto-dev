# Add String Utilities and Text Formatter

## Phase 1: Add string utilities

Create a `src/string-utils.ts` module with basic string manipulation functions.

Requirements:
- `capitalize(str: string): string` — uppercase first letter, lowercase the rest
- `reverse(str: string): string` — reverse the characters in the string
- Handle empty string input (return empty string)

Add tests in `src/string-utils.test.ts` covering each function.

### Acceptance Criteria

1. `src/string-utils.ts` exports `capitalize` and `reverse` functions
2. `src/string-utils.test.ts` contains tests for both functions including empty string edge case
3. All existing tests continue to pass
4. TypeScript compilation passes with no errors

## Phase 2: Add text formatter

Create a `src/formatter.ts` module that **imports from `./string-utils.js`** and provides text formatting utilities.

Requirements:
- `formatTitle(str: string): string` — capitalize each word in the string (split by spaces)
- `formatSlug(str: string): string` — lowercase, replace spaces with hyphens, remove non-alphanumeric characters except hyphens

Add tests in `src/formatter.test.ts` covering each function with multiple cases.

### Acceptance Criteria

1. `src/formatter.ts` imports from `./string-utils.js` and exports `formatTitle` and `formatSlug` functions
2. `src/formatter.test.ts` contains tests for both functions
3. All existing tests (including string-utils tests from Phase 1) continue to pass
4. TypeScript compilation passes with no errors
