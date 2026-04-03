import * as path from "path";
import * as vscode from "vscode";
import {
  VerticalDiffBlock,
  VerticalDiffSession
} from "../diff/vertical/types";
import { VerticalDiffManager } from "../diff/vertical/manager";

function makeBlockPreview(block: VerticalDiffBlock): string {
  const source =
    block.proposedLines.join(" ").trim() ||
    block.originalLines.join(" ").trim() ||
    "<empty>";
  const collapsed = source.replace(/\s+/g, " ");

  if (collapsed.length <= 60) {
    return collapsed;
  }

  return `${collapsed.slice(0, 57)}...`;
}

class ReviewSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: VerticalDiffSession) {
    const pendingCount = session.blocks.filter((block) => block.status === "pending").length;
    const fileName = path.basename(session.uri.fsPath);
    super(fileName, vscode.TreeItemCollapsibleState.Expanded);

    this.id = session.id;
    this.resourceUri = session.uri;
    this.description =
      session.streamState === "streaming"
        ? "Streaming..."
        : `${pendingCount} diff${pendingCount === 1 ? "" : "s"}`;
    this.tooltip = new vscode.MarkdownString(
      `**${fileName}**\n\n${session.uri.fsPath}`
    );
    this.contextValue = "latchReviewSession";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "latch.openReviewSession",
      title: "Open Review Session",
      arguments: [session.id]
    };
  }
}

class ReviewBlockTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly session: VerticalDiffSession,
    public readonly block: VerticalDiffBlock
  ) {
    super(
      `+${block.numGreen} -${block.numRed}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.id = `${session.id}:${block.id}`;
    this.description = makeBlockPreview(block);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${path.basename(session.uri.fsPath)}**`,
        "",
        `Line ${block.startLine + 1}`,
        "",
        "```",
        block.proposedLines.join("\n") || block.originalLines.join("\n") || "<empty>",
        "```"
      ].join("\n")
    );
    this.contextValue = "latchReviewBlock";
    this.iconPath = new vscode.ThemeIcon("diff");
    this.command = {
      command: "latch.revealReviewBlock",
      title: "Reveal Review Block",
      arguments: [session.id, block.id]
    };
  }
}

class ReviewStatusTreeItem extends vscode.TreeItem {
  public constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "latchReviewStatus";
  }
}

type ReviewTreeItem =
  | ReviewSessionTreeItem
  | ReviewBlockTreeItem
  | ReviewStatusTreeItem;

export class ReviewTreeProvider
  implements vscode.TreeDataProvider<ReviewTreeItem>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<ReviewTreeItem | undefined | void>();
  private treeView?: vscode.TreeView<ReviewTreeItem>;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly changeSubscription: vscode.Disposable;

  public constructor(private readonly manager: VerticalDiffManager) {
    this.changeSubscription = this.manager.onDidChangeSessions(() => {
      this.refresh();
    });
  }

  public dispose(): void {
    this.changeSubscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public setTreeView(treeView: vscode.TreeView<ReviewTreeItem>): void {
    this.treeView = treeView;
    this.updateBadge();
  }

  public refresh(): void {
    this.updateBadge();
    this.onDidChangeTreeDataEmitter.fire();
  }

  private updateBadge(): void {
    if (!this.treeView) {
      return;
    }

    const sessions = this.manager.getSessions();
    const pendingBlockCount = sessions.reduce((total, session) => {
      return total + session.blocks.filter((block) => block.status === "pending").length;
    }, 0);

    this.treeView.badge =
      sessions.length > 0
        ? {
            value: sessions.length,
            tooltip: `${sessions.length} review file${
              sessions.length === 1 ? "" : "s"
            }, ${pendingBlockCount} pending block${
              pendingBlockCount === 1 ? "" : "s"
            }`
          }
        : undefined;
  }

  public getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ReviewTreeItem): Promise<ReviewTreeItem[]> {
    if (!element) {
      const sessions = this.manager.getSessions();
      if (sessions.length === 0) {
        return [new ReviewStatusTreeItem("No active inline reviews")];
      }

      return sessions.map((session) => new ReviewSessionTreeItem(session));
    }

    if (element instanceof ReviewSessionTreeItem) {
      const document = await vscode.workspace.openTextDocument(element.session.uri);
      const pendingBlocks = (await this.manager.getPendingViews(
        element.session,
        document
      )).map((view) => view.block);

      if (pendingBlocks.length > 0) {
        return pendingBlocks.map(
          (block) => new ReviewBlockTreeItem(element.session, block)
        );
      }

      if (element.session.streamState === "streaming") {
        return [new ReviewStatusTreeItem("Streaming inline diff...")];
      }

      return [new ReviewStatusTreeItem("No pending diff blocks")];
    }

    return [];
  }
}
