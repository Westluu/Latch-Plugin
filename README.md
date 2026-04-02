# Latch Inline Review

Latch is a VS Code extension scaffold that recreates the core Continue-style inline diff review loop:

- select code in the active editor
- copy a proposed replacement into your clipboard
- run `Latch: Review Selection From Clipboard`
- accept or reject each hunk inline with CodeLens actions

## What it does

This extension focuses on the editor-side UX first:

- computes line hunks between the selected text and the proposed text
- renders inline review affordances directly in the editor
- exposes `Accept`, `Reject`, `Accept All`, `Reject All`, and `Preview` actions
- applies accepted hunks back into the original document without opening a separate diff editor

It is intentionally provider-agnostic right now. That makes it easy to plug in a future LLM source, Continue-style chat command, or custom backend without rewriting the review experience.

## Commands

- `Latch: Review Selection From Clipboard`
- `Latch: Accept Inline Diff`
- `Latch: Reject Inline Diff`
- `Latch: Accept All Inline Diffs`
- `Latch: Reject All Inline Diffs`
- `Latch: Preview Inline Diff`

## Keybindings

- `Cmd+Y` / `Ctrl+Y`: accept the current pending hunk
- `Cmd+N` / `Ctrl+N`: reject the current pending hunk

These only activate while a Latch review session is active.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Implementation Notes

The main entry points are:

- `src/extension.ts` for command registration
- `src/apply/applyManager.ts` for apply orchestration
- `src/diff/vertical/manager.ts` for vertical diff session management and accept/reject logic
- `src/diff/vertical/codeLensProvider.ts` for inline CodeLens actions
- `src/diff/vertical/types.ts` for vertical diff session and hunk types

## Next Steps

- connect the review controller to a real AI edit provider
- support parsing unified diff text directly from the clipboard
- add richer inserted-line rendering beyond the compact inline preview
