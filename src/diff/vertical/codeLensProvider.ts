import * as vscode from "vscode";
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

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.manager.getSession(document.uri);
    if (!session) {
      return [];
    }

    const views = this.manager.getPendingViews(session, document);
    const lenses: vscode.CodeLens[] = [];

    views.forEach((view, index) => {
      const anchor = new vscode.Range(view.range.start, view.range.start);

      lenses.push(
        new vscode.CodeLens(anchor, {
          title: "Accept",
          command: "latch.acceptDiff",
          arguments: [session.id, view.hunk.id]
        }),
        new vscode.CodeLens(anchor, {
          title: "Reject",
          command: "latch.rejectDiff",
          arguments: [session.id, view.hunk.id]
        }),
        new vscode.CodeLens(anchor, {
          title: "Preview",
          command: "latch.previewInlineDiff",
          arguments: [session.id, view.hunk.id]
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

    return lenses;
  }
}
