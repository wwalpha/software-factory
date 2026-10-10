# TypeScript Coding Standards

Apply these rules to TypeScript code under [AGENTS.md](../../AGENTS.md) and
[common.md](common.md), within the existing scope for new or changed code.
Prioritize readability, type safety and correctness, maintainability and
responsibility separation, security and reliability, testability, then removal
of unnecessary code and abstractions. Lines of code are not a quality target.
Enforcement marked as a candidate is not enabled by this document.

## TS-01: Strict Type Safety

- **Rule:** Preserve strict typing without escape hatches.
- **Rationale:** Static contracts detect incompatible callers before execution.
- **Required Practice:** Respect `strict`, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Explicit `any` and `as any` are prohibited. Accept
  unknown external values as `unknown`, then narrow or validate them. Do not hide
  type errors with casts. Static types do not validate runtime input; use the
  canonical validators at boundaries, as specified in ARCH-04.
- **Enforcement:** Current `npm run typecheck` and `npm run lint`, including
  `@typescript-eslint/no-explicit-any`. Runtime rejection needs tests.

## TS-02: Type Assertions

- **Rule:** Assert a type only when evidence establishes it and narrowing cannot.
- **Rationale:** An assertion changes compiler assumptions, not the actual value.
- **Required Practice:** Prefer guards, assertion functions such as `ensure`, or
  validated contracts. Do not use unnecessary assertions, double assertions to
  bypass type checking, `@ts-ignore` or `@ts-nocheck`. Resolve incompatible types
  against the owning contract. Non-null assertions (`!`) are prohibited by default.
- **Exceptions:** A non-null or boundary type assertion requires an established
  invariant the compiler cannot express and a specific explanation at the use
  site. `@ts-expect-error` requires a precise reason, such as a negative type test
  or a verified upstream typing defect; it must not hide an ordinary contract bug.
- **Enforcement:** Current `@typescript-eslint/ban-ts-comment` requires descriptions
  for `@ts-expect-error` and rejects the other suppression directives. Candidate:
  `@typescript-eslint/no-non-null-assertion`; assertion validity needs review.

## TS-03: Type Design

- **Rule:** Reuse the owning contract and represent valid states directly.
- **Rationale:** Duplicate or overly clever types drift and obscure invariants.
- **Required Practice:** Use generated contract types and existing port/local types
  rather than redeclaring their shapes. Keep public inputs and outputs explicit.
  Use `readonly` for values consumers must not mutate. Use unions for alternatives
  and discriminated unions when variants have different required fields. Use
  `interface` for object/service contracts when appropriate and `type` for unions,
  aliases or compositions; neither is categorically forbidden. Add generics or
  conditional types only for a concrete relationship simpler types cannot express.
- **Enforcement:** Current `npm run typecheck` and `npm run schema:check`;
  semantic duplication and complexity need review.

## TS-04: Function Design

- **Rule:** Make each function's responsibility and input/output contract clear.
- **Rationale:** Clear contracts reduce nesting, accidental coupling and unsafe calls.
- **Required Practice:** Apply COM-10's arrow-function requirement and prohibition
  of ordinary `function` declarations/expressions. Existing class methods do not
  require conversion to arrow properties. Give exported APIs and port methods clear
  parameter and return types; allow inference for obvious local expressions.
  Keep parameters necessary to the responsibility, use early returns to reduce
  nesting, and apply COM-04 before introducing wrapper functions.
- **Exceptions:** COM-10 owns the documented language/API exceptions, including
  generators; do not add style-based exceptions.
- **Enforcement:** Current `npm run typecheck` checks call compatibility. Candidate:
  ESLint `no-restricted-syntax` selectors for ordinary function syntax, with the
  documented exceptions preserved.

## TS-05: Conditional Logic

- **Rule:** COM-09 is the authoritative prohibition of every ternary form,
  including nested, chained and JSX expressions.
- **Rationale:** One source for conditional syntax prevents competing style rules.
- **Required Practice:** Follow COM-09's `if` / `else` or early-return approach.
  Break complex conditions into named predicates or intermediate booleans when
  that clarifies meaning; do not introduce unnecessary helpers or deeper nesting.
- **Enforcement:** COM-09 identifies `no-ternary: error` as future enforcement;
  the current ESLint configuration does not enable it. Review changed code now.

## TS-06: Null and Undefined

- **Rule:** Missing, explicitly empty and invalid values must retain their contract meaning.
- **Rationale:** Incorrect defaults can convert failure or unknown state into success.
- **Required Practice:** Preserve each contract's meaning for `null` and `undefined`.
  With exact optional properties, omit an absent optional field unless its type
  explicitly permits `undefined`. Check indexed/optional access before use. Use
  optional chaining when absence is allowed and `??` only for a valid default;
  do not use truthiness to discard valid `0`, `false` or empty strings. Required
  data must fail validation rather than silently take a success-shaped default.
- **Enforcement:** Current `npm run typecheck`; test contract-relevant missing,
  null, zero and false cases.

## TS-07: Error and Result Types

- **Rule:** Error and result types must distinguish success, failure and uncertainty.
- **Rationale:** Callers must not interpret partial or failed work as completed work.
- **Required Practice:** Narrow unknown caught values with `instanceof Error` or
  existing classification helpers before reading properties. Follow NODE-03 for
  propagation and cause preservation. Reuse `FactoryError`, existing operation
  results and generated state contracts; do not invent a parallel generic Result
  framework. Prefer variants that make incompatible state combinations difficult
  to construct; preserve existing persisted shapes and compatibility.
- **Enforcement:** Current `npm run typecheck` and relevant error/state tests.

## TS-08: Readability

- **Rule:** Types must clarify intent rather than compress the implementation.
- **Rationale:** Readers need to understand contracts without decoding type tricks.
- **Required Practice:** Apply COM-05 to names; boolean names must make the meaning
  of `true` clear. Use inference for obvious local values and annotations where
  they explain a boundary. Avoid unnecessary conversions and annotations that
  repeat an evident initializer type. Do not use complex type operators merely
  because they shorten code; prefer a readable type or direct implementation.
- **Enforcement:** Current `npm run typecheck` and unused-variable lint checks;
  readability requires review rather than a line-count threshold.

## TS-09: Modern TypeScript

- **Rule:** Apply COM-10's modern syntax policy within the configured compiler target.
- **Rationale:** Language conventions must share one owner and match runtime support.
- **Required Practice:** Follow COM-10 for the `var` and CommonJS prohibitions,
  `const` preference, strict equality, destructuring, rest/spread, template literals
  and removal of unnecessary legacy patterns. Respect ES2023/NodeNext and
  `verbatimModuleSyntax`; use `import type` for type-only dependencies. Do not weaken
  compiler options to accept an incompatible implementation.
- **Enforcement:** Current `npm run typecheck` and `npm run lint` provide partial
  coverage. Candidate: ESLint `eqeqeq`; do not claim all COM-10 syntax is lint-enforced.
