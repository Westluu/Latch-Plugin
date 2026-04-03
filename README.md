# Latch Inline Review

Latch is a VS Code extension scaffold for reviewing the active file's git diff inline:

- open a modified file in the active editor
- run `Latch: Review Active File Git Diff`
- accept or reject each hunk inline with CodeLens actions

Active review sessions also appear in the dedicated `Latch` sidebar, with one entry per file and nested diff blocks you can click to jump straight to the decorated region in the editor.

## What it does

This extension focuses on the editor-side UX first for git-backed file reviews:

- uses the active file's git hunks as the review blocks
- renders inline review affordances directly in the editor
- exposes `Accept`, `Reject`, `Accept All`, `Reject All`, and `Preview` actions
- applies accepted hunks back into the original document without opening a separate diff editor

## Commands

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
- `src/diff/gitDiff.ts` for parsing unified git diffs and turning hunks into review blocks
- `src/diff/vertical/manager.ts` for review session orchestration
- `src/diff/vertical/codeLensProvider.ts` for inline CodeLens actions
- `src/diff/vertical/types.ts` for vertical diff session and hunk types

## Next Steps

- connect the extension to an external AI edit provider
- add richer inserted-line rendering beyond the compact inline preview
