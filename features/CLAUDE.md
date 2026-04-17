# Feature Notes

Each file in this folder documents a feature or commit being worked on.

## File Naming

Use the branch or feature name, kebab-cased:
```
feat-abandon-vote.md
fix-bot-takeover-race.md
refactor-game-room-alarms.md
```

## Required Sections

### Goal
One paragraph. What problem does this solve? What should the player experience after this change?

### Approach
Bullet list of the key design decisions. Why this approach over alternatives?

### Files Touched
List every file you expect to modify and why.

### Acceptance Criteria
Checkbox list. These must all be true before the feature is considered done.
- [ ] Example criterion

### Open Questions
Anything unresolved that needs a decision before or during implementation.

## Optional Sections

### Known Risks
Edge cases, race conditions, or regressions to watch for.

### Test Plan
How to manually verify the feature end-to-end (e.g. steps in the browser or via WebSocket messages).

### Notes / Decisions Log
Running log of decisions made during implementation. Append don't overwrite — useful for PR descriptions and post-mortems.

## Tips

- Write the file **before** coding, not after. It forces you to think through the design.
- Keep it short. Bullet points over paragraphs.
- Update acceptance criteria as you discover new requirements.
- Paste the file content into your PR description when done.
