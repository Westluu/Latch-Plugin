import * as vscode from 'vscode';
import { ReviewHunk } from '../types';
import { ReviewSessionService } from '../review/reviewSessionService';

export class ReviewCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
	private readonly sessionListener: vscode.Disposable;

	public constructor(private readonly sessionService: ReviewSessionService) {
		this.sessionListener = this.sessionService.onDidChangeSession(() => this.onDidChangeCodeLensesEmitter.fire());
	}

	public dispose(): void {
		this.onDidChangeCodeLensesEmitter.dispose();
		this.sessionListener.dispose();
	}

	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const isInDiffEditor = vscode.window.tabGroups.all
			.flatMap(g => g.tabs)
			.some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === document.uri.toString());
		if (!isInDiffEditor) {
			return [];
		}

		const file = this.sessionService.getReviewFiles().find(candidate => candidate.uri.toString() === document.uri.toString());
		if (!file) {
			return [];
		}

		return file.hunks.flatMap(hunk => this.createCodeLenses(document, hunk));
	}

	private createCodeLenses(document: vscode.TextDocument, hunk: ReviewHunk): vscode.CodeLens[] {
		if (hunk.state === 'accepted' || hunk.state === 'rejected') {
			return [];
		}

		const blockStart = hunk.kind === 'delete' ? hunk.anchorLine : hunk.displayNewStart;
		const line = Math.max(0, Math.min(document.lineCount === 0 ? 0 : document.lineCount - 1, blockStart - 1));
		const range = new vscode.Range(line, 0, line, 0);
		const lenses: vscode.CodeLens[] = [];

		if (hunk.kind === 'delete') {
			lenses.push(new vscode.CodeLens(range, {
				command: 'latch.inspectDeletedText',
				title: 'Inspect Deleted Text',
				arguments: [hunk]
			}));
		}

		lenses.push(
			new vscode.CodeLens(range, {
				command: 'latch.acceptHunk',
				title: 'Accept',
				arguments: [hunk]
			}),
			new vscode.CodeLens(range, {
				command: 'latch.rejectHunk',
				title: 'Reject',
				arguments: [hunk]
			})
		);

		return lenses;
	}
}
