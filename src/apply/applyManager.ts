import * as vscode from "vscode";
import {
  buildReviewBlocksFromFilePatch,
  findPatchForDocument,
  getGitDiffForDocument,
  reversePatchToDocumentText
} from "../diff/gitDiff";
import { VerticalDiffManager } from "../diff/vertical/manager";

/**
 * "apply orchestration" from "diff rendering".
 * This class mirrors that shape for our extension: it gathers the proposed
 * edit, validates editor state, and delegates the inline review lifecycle
 * to VerticalDiffManager.
 */
export class ApplyManager {
  public constructor(private readonly verticalDiffManager: VerticalDiffManager) {}

  public async reviewGitDiffForActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file first.");
      return;
    }

    if (editor.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage(
        "Git diff review only works for files on disk."
      );
      return;
    }

    if (editor.document.isDirty) {
      void vscode.window.showWarningMessage(
        "Save the file before reviewing its git diff."
      );
      return;
    }

    let diffText: string;
    try {
      diffText = await getGitDiffForDocument(editor.document);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to run git diff for the active file: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    const filePatch = findPatchForDocument(diffText, editor.document.uri);
    if (!filePatch) {
      void vscode.window.showInformationMessage(
        "The active file has no changes against HEAD."
      );
      return;
    }

    if (filePatch.newPath === "/dev/null" || filePatch.oldPath === "/dev/null") {
      void vscode.window.showWarningMessage(
        "New-file and deleted-file patches are not supported yet."
      );
      return;
    }

    try {
      const proposedText = editor.document.getText();
      const originalText = reversePatchToDocumentText(proposedText, filePatch);
      const reviewBlocks = buildReviewBlocksFromFilePatch(filePatch);
      await editor.edit(
        (builder) => {
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
          );
          builder.replace(fullRange, originalText);
        },
        { undoStopAfter: false, undoStopBefore: false }
      );
      await this.verticalDiffManager.startDocumentReview(
        editor,
        proposedText,
        reviewBlocks
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to review git diff: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
