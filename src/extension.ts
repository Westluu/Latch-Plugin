import * as vscode from "vscode";
import { ApplyManager } from "./apply/applyManager";
import { VerticalDiffManager } from "./diff/vertical/manager";

export function activate(context: vscode.ExtensionContext): void {
  const verticalDiffManager = new VerticalDiffManager(context);
  const applyManager = new ApplyManager(verticalDiffManager);

  context.subscriptions.push(
    verticalDiffManager,
    vscode.commands.registerCommand(
      "latch.reviewSelectionFromClipboard",
      async () => {
        await applyManager.reviewSelectionFromClipboard();
      }
    ),
    vscode.commands.registerCommand(
      "latch.acceptDiff",
      async (sessionId?: string, hunkId?: string) => {
        await verticalDiffManager.acceptDiff(sessionId, hunkId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.rejectDiff",
      async (sessionId?: string, hunkId?: string) => {
        await verticalDiffManager.rejectDiff(sessionId, hunkId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.acceptAllDiffs",
      async (sessionId?: string) => {
        await verticalDiffManager.acceptAllDiffs(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.rejectAllDiffs",
      async (sessionId?: string) => {
        await verticalDiffManager.rejectAllDiffs(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.previewInlineDiff",
      async (sessionId?: string, hunkId?: string) => {
        await verticalDiffManager.previewInlineDiff(sessionId, hunkId);
      }
    )
  );
}

export function deactivate(): void {}
