import * as vscode from 'vscode';
import { ReviewSessionService } from './reviewSessionService';

export const LATCH_REVIEW_ORIGINAL_SCHEME = 'latch-review-original';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	public constructor(private readonly sessionService: ReviewSessionService) {
		this.sessionService.onDidChangeSession(() => {
			for (const file of this.sessionService.getReviewFiles()) {
				this.onDidChangeEmitter.fire(file.originalUri);
			}
		});
	}

	public provideTextDocumentContent(uri: vscode.Uri): string {
		return this.sessionService.getOriginalText(uri) ?? '';
	}

	public dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}
