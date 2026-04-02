# VS Code Extension Quickstart

## Run the extension

1. Install dependencies with `npm install`.
2. Compile the project with `npm run compile`.
3. Open this folder in VS Code.
4. Press `F5` to start an Extension Development Host.

## Try the inline review flow

1. Open any code file in the Extension Development Host.
2. Select a block of code.
3. Copy the proposed replacement text into your clipboard.
4. Run `Latch: Review Selection From Clipboard`.
5. Use the inline `Accept` and `Reject` CodeLens actions to process each hunk.

## Project layout

- `src/extension.ts`: activation and command wiring
- `src/apply/applyManager.ts`: apply orchestration
- `src/diff/vertical/manager.ts`: vertical diff state and rendering
- `src/diff/vertical/codeLensProvider.ts`: inline CodeLens actions
- `src/diff/vertical/types.ts`: diff session types
