import * as vscode from 'vscode';
import { ReviewFile, ReviewHunk } from '../types';
import { ReviewSessionService } from '../review/reviewSessionService';

export type ReviewTreeItem = ReviewFile | ReviewHunk;

export class ReviewTreeDataProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ReviewTreeItem | undefined>();

	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	public constructor(private readonly sessionService: ReviewSessionService) {
		this.sessionService.onDidChangeSession(() => this.refresh());
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	public getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
			if ('uri' in element) {
				const counts = this.sessionService.getCounts(element);
				const item = new vscode.TreeItem(
					element.path,
					this.sessionService.isExpanded(element.id)
						? vscode.TreeItemCollapsibleState.Expanded
						: vscode.TreeItemCollapsibleState.Collapsed
				);
			item.id = element.id;
			item.contextValue = 'latchReviewFile';
			item.description = `${counts.pending} pending`;
			item.tooltip = `${element.path}\nAccepted: ${counts.accepted}, Rejected: ${counts.rejected}, Conflicted: ${counts.conflicted}, Stale: ${counts.stale}`;
			item.command = {
				command: 'latch.openReviewItem',
				title: 'Open File',
				arguments: [element]
			};
			item.iconPath = new vscode.ThemeIcon(element.conflicted ? 'warning' : 'file-diff');
			return item;
		}

		const title = this.getHunkLabel(element);
		const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
		item.id = element.id;
		item.contextValue = 'latchReviewHunk';
		item.description = element.state;
		item.tooltip = `${element.kind} hunk\n${element.header || '(no header)'}`;
		item.command = {
			command: 'latch.openReviewItem',
			title: 'Open Hunk',
			arguments: [element]
		};
		item.iconPath = new vscode.ThemeIcon(this.getIconName(element.state));
		return item;
	}

	public getChildren(element?: ReviewTreeItem): Thenable<ReviewTreeItem[]> {
		if (!element) {
			return Promise.resolve([...this.sessionService.getReviewFiles()]);
		}

		if ('uri' in element) {
			return Promise.resolve([...element.hunks]);
		}

		return Promise.resolve([]);
	}

	private getHunkLabel(hunk: ReviewHunk): string {
		if (hunk.kind === 'delete') {
			return `Deleted ${Math.max(hunk.oldLineCount, 1)} line${Math.max(hunk.oldLineCount, 1) === 1 ? '' : 's'}`;
		}

		const line = hunk.displayNewStart || hunk.oldStart;
		return `${hunk.kind} at line ${line}`;
	}

	private getIconName(state: ReviewHunk['state']): string {
		switch (state) {
			case 'accepted':
				return 'pass-filled';
			case 'rejected':
				return 'discard';
			case 'conflicted':
				return 'warning';
			case 'stale':
				return 'history';
			default:
				return 'diff';
		}
	}
}
