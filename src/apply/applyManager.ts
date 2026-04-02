import * as vscode from "vscode";
import { VerticalDiffManager } from "../diff/vertical/manager";

/**
 * Continue.dev separates "apply orchestration" from "diff rendering".
 * This class mirrors that shape for our extension: it gathers the proposed
 * edit, validates editor state, and delegates the inline review lifecycle
 * to VerticalDiffManager.
 */
export class ApplyManager {
  public constructor(private readonly verticalDiffManager: VerticalDiffManager) {}

  public async reviewSelectionFromClipboard(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file and select text first.");
      return;
    }

    if (editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select the code you want to review first.");
      return;
    }

    const proposedText = await vscode.env.clipboard.readText();
    if (!proposedText.trim()) {
      void vscode.window.showWarningMessage(
        "Clipboard is empty. Copy the proposed replacement and try again."
      );
      return;
    }

    await this.verticalDiffManager.startReview(editor, proposedText);
  }
}
