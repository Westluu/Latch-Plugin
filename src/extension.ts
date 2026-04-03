import * as vscode from "vscode";
import { ApplyManager } from "./apply/applyManager";
import { ReviewSessionManager } from "./review/sessionManager";
import { ReviewTreeProvider } from "./sidebar/reviewTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const reviewSessionManager = new ReviewSessionManager();
  reviewSessionManager.register(context);
  const applyManager = new ApplyManager(reviewSessionManager);
  const reviewTreeProvider = new ReviewTreeProvider(reviewSessionManager);
  const reviewTreeView = vscode.window.createTreeView("latch.reviewSidebar", {
    treeDataProvider: reviewTreeProvider,
    showCollapseAll: true
  });
  reviewTreeProvider.setTreeView(reviewTreeView);

  context.subscriptions.push(
    reviewSessionManager,
    reviewTreeProvider,
    reviewTreeView,
    vscode.commands.registerCommand(
      "latch.reviewActiveFileGitDiff",
      async () => {
        await applyManager.reviewGitDiffForActiveFile();
      }
    ),
    vscode.commands.registerCommand(
      "latch.acceptDiff",
      async (sessionId?: string, hunkId?: string) => {
        await reviewSessionManager.acceptDiff(sessionId, hunkId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.rejectDiff",
      async (sessionId?: string, hunkId?: string) => {
        await reviewSessionManager.rejectDiff(sessionId, hunkId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.acceptAllDiffs",
      async (sessionId?: string) => {
        await reviewSessionManager.acceptAllDiffs(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.rejectAllDiffs",
      async (sessionId?: string) => {
        await reviewSessionManager.rejectAllDiffs(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.previewInlineDiff",
      async (sessionId?: string, hunkId?: string) => {
        await reviewSessionManager.previewInlineDiff(sessionId, hunkId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.openReviewSession",
      async (sessionId?: string) => {
        await reviewSessionManager.revealSession(sessionId);
      }
    ),
    vscode.commands.registerCommand(
      "latch.revealReviewBlock",
      async (sessionId?: string, blockId?: string) => {
        await reviewSessionManager.revealBlock(sessionId, blockId);
      }
    )
  );
}

export function deactivate(): void {}
