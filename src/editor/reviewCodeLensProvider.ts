import * as vscode from 'vscode';
import { ReviewHunk } from '../types';
import { ReviewSessionService } from '../review/reviewSessionService';

export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

	public constructor(private readonly sessionService: ReviewSessionService) {
		this.sessionService.onDidChangeSession(() => this.onDidChangeCodeLensesEmitter.fire());
	}

	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const file = this.sessionService.getReviewFiles().find(candidate => candidate.uri.toString() === document.uri.toString());
		if (!file) {
			return [];
		}

		return file.hunks.flatMap(hunk => this.createCodeLenses(document, hunk));
	}

	private createCodeLenses(document: vscode.TextDocument, hunk: ReviewHunk): vscode.CodeLens[] {
		const targetLine = hunk.kind === 'delete' ? hunk.anchorLine : hunk.displayNewStart;
		const line = Math.max(0, Math.min(document.lineCount === 0 ? 0 : document.lineCount - 1, targetLine - 1));
		const range = new vscode.Range(line, 0, line, 0);
		const lenses: vscode.CodeLens[] = [
			new vscode.CodeLens(range, {
				command: 'latch.openReviewItem',
				title: this.getSummaryTitle(hunk),
				arguments: [hunk]
			}),
			new vscode.CodeLens(range, {
				command: 'latch.acceptHunk',
				title: hunk.state === 'accepted' ? 'Accepted' : 'Accept',
				arguments: [hunk]
			}),
			new vscode.CodeLens(range, {
				command: 'latch.rejectHunk',
				title: hunk.state === 'rejected' ? 'Rejected' : 'Reject',
				arguments: [hunk]
			})
		];

		if (hunk.kind === 'delete') {
			lenses.unshift(new vscode.CodeLens(range, {
				command: 'latch.inspectDeletedText',
				title: 'Inspect Deleted Text',
				arguments: [hunk]
			}));
		}

		return lenses;
	}

	private getSummaryTitle(hunk: ReviewHunk): string {
		switch (hunk.kind) {
			case 'insert':
				return `Added ${Math.max(hunk.displayNewLineCount, hunk.newLineCount, 1)} line${Math.max(hunk.displayNewLineCount, hunk.newLineCount, 1) === 1 ? '' : 's'}`;
			case 'delete':
				return `Deleted ${Math.max(hunk.oldLineCount, 1)} line${Math.max(hunk.oldLineCount, 1) === 1 ? '' : 's'}`;
			default:
				return `Changed ${Math.max(hunk.displayNewLineCount, hunk.displayOldLineCount, 1)} line${Math.max(hunk.displayNewLineCount, hunk.displayOldLineCount, 1) === 1 ? '' : 's'}`;
		}
	}
}
