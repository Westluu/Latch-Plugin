import * as vscode from "vscode";
import { ApplyManager } from "./apply/applyManager";
import { VerticalDiffManager } from "./diff/vertical/manager";
import { ReviewTreeProvider } from "./sidebar/reviewTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const verticalDiffManager = new VerticalDiffManager(context);
  const applyManager = new ApplyManager(verticalDiffManager);
  const reviewTreeProvider = new ReviewTreeProvider(verticalDiffManager);
  const reviewTreeView = vscode.window.createTreeView("latch.reviewSidebar", {
    treeDataProvider: reviewTreeProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    verticalDiffManager,
    reviewTreeProvider,
    reviewTreeView,
    vscode.commands.registerCommand(
      "latch.reviewSelectionFromClipboard",
      async () => {
        await applyManager.reviewSelectionFromClipboard();
      }
    ),
    vscode.commands.registerCommand(
      "latch.reviewGitDiffFromClipboard",
      async () => {
        await applyManager.reviewGitDiffForActiveFile();
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
    ),
    vscode.commands.registerCommand(
      "latch.abortInlineDiff",
      (sessionId?: string) => {
        verticalDiffManager.abortDiff(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.openReviewSession",
      async (sessionId?: string) => {
        await verticalDiffManager.revealSession(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.revealReviewBlock",
      async (sessionId?: string, blockId?: string) => {
        await verticalDiffManager.revealBlock(sessionId, blockId);
      }
    )
  );
}

export function deactivate(): void {}
