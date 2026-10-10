# Common Development Rules

These rules apply repository-wide under the priority defined in
[AGENTS.md](../../AGENTS.md). They refine its working principles without repeating
the project overview or execution workflow.

Prioritize, in order: code quality, readability and maintainability; protection of
existing functionality and architecture; LLM token efficiency; and removal of
unnecessary implementation, abstraction and processing. Apply coding rules to new
or changed code; do not retrofit untouched code or perform bulk conversions solely
for compliance.

## COM-01: Understand Before Modifying

- Understand the target and related implementations before changing them. Check
  existing behavior, contracts, dependencies, affected callers and tests.
- Base implementation decisions on evidence, not assumptions alone. Do not
  reimplement functionality without investigating its existing implementation.

## COM-02: Scope Control

- Make the smallest complete change within the requested scope. Preserve unrelated
  work; do not perform unrelated refactoring.
- Do not add compatibility handling without a demonstrated requirement.

## COM-03: Reusability

- Prefer existing implementations, project patterns and available libraries.
- Do not duplicate logic or assign the same responsibility to multiple owners.
- Introduce an abstraction only when its necessity is established for the current
  task.

## COM-04: Design Quality

- Favor the Single Responsibility Principle and simple, understandable code while
  preserving the existing architecture and its trust boundaries.
- Do not create unnecessary wrappers, helpers or adapters, generalize for imagined
  future requirements, or split files excessively.
- Do not reduce quality merely to reduce lines of code.

## COM-05: Naming and Comments

- Use names that communicate role and intent.
- Comments should explain why, especially non-obvious constraints and design
  decisions. Do not repeat behavior already clear from the code.
- Add only comments and documentation needed to understand or operate the change.

## COM-06: Safety

- Preserve existing security boundaries, including the separation of runtime,
  Guard, operator authority and protected acceptance evidence.
- Never place secrets or credentials in code or logs.
- Do not bypass Guard, approval, sandbox or other authorization constraints.
- Establish the necessity and impact of destructive operations before executing
  them. Do not delete existing assets without explicit permission.

## COM-07: Validation

- Perform validation appropriate to the change, reusing existing checks. Do not
  repeat full test suites or broaden validation without a relevant reason.
- Never report unexecuted, failed or blocked checks as PASS. Distinguish agent
  claims from verified acceptance evidence, and mock/offline checks from live
  validation.
- Report validation failures and their known causes; identify unknown causes and
  environmental blocks honestly.

## COM-08: Reporting

- Keep final reports concise: changes, validation results, unresolved issues and
  risks. Identify changed files and checks skipped or blocked where relevant.
- Do not reproduce complete investigation logs, repeat explanations, write
  unnecessarily long reports or narrate each internal processing step.

## COM-09: Prohibit Ternary Operators

- Ternary operators are prohibited in all forms: single, nested, chained and
  within JSX. There are no style-based exceptions.
- Use `if` / `else` or early returns, prioritizing readability.
- Future ESLint enforcement is `no-ternary: error`. This rule introduction does
  not change ESLint configuration or bulk-convert existing code.

## COM-10: Modern JavaScript / TypeScript

- Use modern ES2015+ syntax as the standard, within the project's supported
  runtime and existing contracts.
- Prohibit ordinary `function` declarations and expressions, `var`,
  `require` / `module.exports`, `arguments`, manual prototype inheritance,
  `==` / `!=` and unnecessary legacy compatibility patterns.
- Use arrow functions for ordinary functions; prefer `const` / `let`, ES modules,
  rest/spread, template literals, destructuring, `async` / `await` and
  `===` / `!==` where appropriate.
- Allow only the minimum necessary exceptions for constructs arrow functions
  cannot express (such as generators), external API requirements or execution-tool
  constraints. Document the specific reason for each exception.
- Do not bulk-convert existing code.

### Context Management

- Include only information needed for the task. Locate relevant sections through
  search before reading; do not unconditionally load large files in full.
- Avoid retrieving or explaining known information again, and avoid duplicate
  context. Compress long histories into necessary facts, constraints and decisions.

### Tool Execution

- Obtain the needed information with the fewest sufficient tool calls; do not
  repeat calls serving the same purpose without a new need.
- Filter large output before passing it to the LLM. Prefer important errors,
  differences and aggregate results over full logs.
- Do not explore the whole repository or rerun tests without necessity.

### Agent Communication

- Keep inter-agent messages structured, concise and relevant to the assigned task.
  Do not repeatedly expand the same specifications or instructions.
- Report differences, validation results and remaining risks. Reuse existing
  artifacts and references instead of placing huge intermediate artifacts in the
  conversation.

### Reasoning and Execution

- Keep planning proportionate to task size; avoid unnecessary confirmations for
  clear tasks.
- Avoid aimless trial and error or regeneration. Identify the cause of failure
  before retrying; do not retry indefinitely under identical conditions.
- Reuse existing decisions and validation results when they remain applicable to
  the current change and environment. Historical results alone do not establish
  that the current checkout passed.

### Output Optimization

- Lead with the conclusion and provide enough explanation to complete the task.
- Do not unconditionally output large logs or code. Prefer differences over full
  contents when reporting changes, and do not repeat the same content in multiple
  formats.

### Quality Priority

Token savings must not sacrifice accuracy, safety, readability, required
validation, required evidence or completeness of user-requested information.
