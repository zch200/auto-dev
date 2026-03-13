# Add Slugify Utility

## Phase 1: Add slugify function

Create a `slugify` utility function in `src/slugify.ts` that converts a string to a URL-friendly slug.

Requirements:
- Convert to lowercase
- Replace spaces and special characters with hyphens
- Remove consecutive hyphens
- Trim hyphens from start and end

Add comprehensive tests in `src/slugify.test.ts`.

### Acceptance Criteria

1. `src/slugify.ts` exports a `slugify(input: string): string` function
2. `src/slugify.test.ts` contains tests covering: basic conversion, special characters, consecutive spaces, leading/trailing spaces
3. All existing tests continue to pass
4. TypeScript compilation passes with no errors
