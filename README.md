# Latch Inline Review

Latch is a VS Code extension scaffold that recreates the core inline diff review loop:

- select code in the active editor
- copy a proposed replacement into your clipboard
- run `Latch: Review Selection From Clipboard`
- accept or reject each hunk inline with CodeLens actions

It also supports reviewing the active file directly against its Git diff.

Active review sessions also appear in the Explorer sidebar under `Latch Reviews`, with one entry per file and nested diff blocks you can click to jump straight to the decorated region in the editor.

## What it does

This extension focuses on the editor-side UX first:

- computes line hunks between the selected text and the proposed text
- renders inline review affordances directly in the editor
- exposes `Accept`, `Reject`, `Accept All`, `Reject All`, and `Preview` actions
- applies accepted hunks back into the original document without opening a separate diff editor

It is intentionally provider-agnostic right now. That makes it easy to plug in a future LLM source, Continue-style chat command, or custom backend without rewriting the review experience.

## Commands

- `Latch: Review Selection From Clipboard`
- `Latch: Review Active File Git Diff`
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

If `F5` asks about debugging Markdown, make sure you launched the workspace debug config named `Run Latch Extension`. That happens when VS Code tries to debug the active `README.md` file instead of the extension host.

For git diffs:

1. Open the target file in the editor.
2. Make sure the file is saved.
3. Click the `Review Active File Git Diff` action in the editor title, or run `Latch: Review Active File Git Diff`.
4. Latch runs `git diff HEAD -- <active-file>`, restores the file to the Git base, and then shows the current file contents back as an inline review.
5. Review the proposed changes inline, or use the `Latch Reviews` sidebar to jump between diff blocks.

## Implementation Notes

The main entry points are:

- `src/extension.ts` for command registration
- `src/apply/applyManager.ts` for apply orchestration
- `src/diff/gitDiff.ts` for parsing and applying unified git diffs from external tools
- `src/diff/vertical/manager.ts` for vertical diff session management and accept/reject logic
- `src/diff/vertical/codeLensProvider.ts` for inline CodeLens actions
- `src/diff/vertical/types.ts` for vertical diff session and hunk types

## Next Steps

- connect the extension to an external AI edit provider
- add richer inserted-line rendering beyond the compact inline preview
