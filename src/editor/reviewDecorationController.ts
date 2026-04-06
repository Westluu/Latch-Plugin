import * as vscode from 'vscode';
import { ReviewFile, ReviewHunk } from '../types';
import { ReviewSessionService } from '../review/reviewSessionService';

export class ReviewDecorationController implements vscode.Disposable {
	private readonly insertDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground')
	});

	private readonly replaceDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground')
	});

	private readonly deleteAnchorDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
		borderStyle: 'dashed',
		borderWidth: '1px 0 1px 0',
		after: {
			margin: '0 0 0 1rem',
			color: new vscode.ThemeColor('descriptionForeground')
		}
	});

	private readonly disposables: vscode.Disposable[] = [];

	public constructor(private readonly sessionService: ReviewSessionService) {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.render()),
			vscode.workspace.onDidOpenTextDocument(() => this.render())
		);
		this.sessionService.onDidChangeSession(() => this.render());
	}

	public render(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.renderEditor(editor);
		}
	}

	private renderEditor(editor: vscode.TextEditor): void {
		const file = this.sessionService.getReviewFiles().find(candidate => candidate.uri.toString() === editor.document.uri.toString());
		if (!file) {
			editor.setDecorations(this.insertDecoration, []);
			editor.setDecorations(this.replaceDecoration, []);
			editor.setDecorations(this.deleteAnchorDecoration, []);
			return;
		}

		editor.setDecorations(this.insertDecoration, this.getDecorationOptions(editor.document, file, 'insert'));
		editor.setDecorations(this.replaceDecoration, this.getDecorationOptions(editor.document, file, 'replace'));
		editor.setDecorations(this.deleteAnchorDecoration, this.getDeleteDecorationOptions(editor.document, file));
	}

	private getDecorationOptions(document: vscode.TextDocument, file: ReviewFile, kind: 'insert' | 'replace'): vscode.DecorationOptions[] {
		return file.hunks
			.filter(hunk => hunk.kind === kind && hunk.state !== 'rejected')
			.map(hunk => {
				const startLine = Math.max(0, hunk.displayNewStart - 1);
				const lineCount = Math.max(hunk.displayNewLineCount, 1);
				const endLine = Math.min(document.lineCount, Math.max(startLine + lineCount, startLine + 1));
				return {
					range: new vscode.Range(startLine, 0, endLine, 0),
					hoverMessage: this.getHover(hunk)
				};
			});
	}

	private getDeleteDecorationOptions(document: vscode.TextDocument, file: ReviewFile): vscode.DecorationOptions[] {
		return file.hunks
			.filter(hunk => hunk.kind === 'delete' && hunk.state !== 'rejected')
			.map(hunk => {
				const line = Math.max(0, Math.min(document.lineCount === 0 ? 0 : document.lineCount - 1, hunk.anchorLine - 1));
				return {
					range: new vscode.Range(line, 0, line, 0),
					hoverMessage: this.getHover(hunk),
					renderOptions: {
						after: {
							contentText: `Deleted ${Math.max(hunk.oldLineCount, 1)} line${Math.max(hunk.oldLineCount, 1) === 1 ? '' : 's'}`
						}
					}
				};
			});
	}

	private getHover(hunk: ReviewHunk): vscode.MarkdownString {
		const value = new vscode.MarkdownString();
		value.isTrusted = false;
		value.supportThemeIcons = true;
		value.appendMarkdown(`**${hunk.kind}**\n\n`);
		value.appendMarkdown(`State: \`${hunk.state}\`\n\n`);
		if (hunk.header) {
			value.appendMarkdown(`${hunk.header}\n\n`);
		}
		if (hunk.kind === 'delete') {
			value.appendCodeblock(hunk.originalText, 'text');
		}
		return value;
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.insertDecoration.dispose();
		this.replaceDecoration.dispose();
		this.deleteAnchorDecoration.dispose();
	}
}
