import * as vscode from "vscode";
import { getGitDiffForDocument } from "../gitDiff";
import type { VerticalDiffManager } from "./manager";

export class VerticalDiffCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  public constructor(private readonly manager: VerticalDiffManager) {}

  public dispose(): void {
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  public refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    const session = this.manager.getSession(document.uri);
    if (!session) {
      if (document.uri.scheme !== "file" || document.isDirty) {
        return [];
      }

      try {
        const diffText = await getGitDiffForDocument(document);
        if (!diffText.trim()) {
          return [];
        }
      } catch {
        return [];
      }

      const startRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0)
      );

      return [
        new vscode.CodeLens(startRange, {
          title: "Review Active File Git Diff",
          command: "latch.reviewActiveFileGitDiff"
        })
      ];
    }

    const startRange = new vscode.Range(
      new vscode.Position(session.selectionStartLine, 0),
      new vscode.Position(session.selectionStartLine, 0)
    );

    const views = await this.manager.getPendingViews(session, document);
    const lenses: vscode.CodeLens[] = [];

    views.forEach((view, index) => {
      const anchor = new vscode.Range(view.range.start, view.range.start);

      lenses.push(
        new vscode.CodeLens(anchor, {
          title: "Accept",
          command: "latch.acceptDiff",
          arguments: [session.id, view.block.id]
        }),
        new vscode.CodeLens(anchor, {
          title: "Reject",
          command: "latch.rejectDiff",
          arguments: [session.id, view.block.id]
        }),
        new vscode.CodeLens(anchor, {
          title: "Preview",
          command: "latch.previewInlineDiff",
          arguments: [session.id, view.block.id]
        })
      );

      if (index === 0) {
        lenses.push(
          new vscode.CodeLens(anchor, {
            title: "Accept All",
            command: "latch.acceptAllDiffs",
            arguments: [session.id]
          }),
          new vscode.CodeLens(anchor, {
            title: "Reject All",
            command: "latch.rejectAllDiffs",
            arguments: [session.id]
          })
        );
      }
    });

    if (lenses.length === 0) {
      lenses.push(
        new vscode.CodeLens(startRange, {
          title: "Preview",
          command: "latch.previewInlineDiff",
          arguments: [session.id]
        })
      );
    }

    return lenses;
  }
}
