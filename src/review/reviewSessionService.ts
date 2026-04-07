import * as path from 'path';
import * as vscode from 'vscode';
import { GitDiffReviewSessionInput, ParsedDiffFile, PersistedReviewSession, ReviewCounts, ReviewFile, ReviewHunk, ReviewHunkKind, ReviewHunkState, ReviewSession } from '../types';
import { parseGitDiff } from '../parser/gitDiffParser';
import { reconstructOriginalText, splitLines, joinLines } from './originalContent';
import { LATCH_REVIEW_ORIGINAL_SCHEME } from './originalContentProvider';

const STORAGE_KEY = 'latch.reviewSession';

export class ReviewSessionService implements vscode.Disposable {
	private readonly onDidChangeSessionEmitter = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [];
	private session: ReviewSession | undefined;
	private persistedInput: GitDiffReviewSessionInput | undefined;
	private readonly fileWatchers = new Map<string, vscode.Disposable>();

	public readonly onDidChangeSession = this.onDidChangeSessionEmitter.event;

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(this.onDidChangeSessionEmitter);
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(event => {
				this.handleTextDocumentChange(event).catch(error => {
					void vscode.window.showErrorMessage(`Latch review failed to revalidate hunks: ${error instanceof Error ? error.message : String(error)}`);
				});
			})
		);
	}

	public async restoreSession(): Promise<boolean> {
		const persisted = this.context.workspaceState.get<PersistedReviewSession>(STORAGE_KEY);
		if (!persisted) {
			return false;
		}

		await this.startReviewSession(persisted.input, persisted);
		return true;
	}

	public async startReviewSession(input: GitDiffReviewSessionInput, persisted?: PersistedReviewSession): Promise<void> {
		if (input.source.kind !== 'gitDiff') {
			throw new Error(`Unsupported source kind: ${input.source.kind}`);
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			throw new Error('Open a workspace folder before starting a review session.');
		}

		const parsedFiles = parseGitDiff(input.source.diffText);
		const files = await Promise.all(parsedFiles.map(async parsedFile => this.createReviewFile(parsedFile, input, workspaceFolder.uri)));
		this.applyPersistedState(files, persisted);

		this.session = {
			sessionId: input.sessionId,
			title: input.title,
			sourceKind: 'gitDiff',
			files,
			fileOrder: files.map(file => file.id),
			activeFileId: persisted?.activeFileId ?? files[0]?.id,
			activeHunkId: persisted?.activeHunkId ?? files[0]?.hunks[0]?.id,
			expandedFileIds: new Set(persisted?.expandedFileIds ?? files.map(file => file.id))
		};
		this.persistedInput = input;
		this.refreshWatchers();
		await this.saveSession();
		this.onDidChangeSessionEmitter.fire();
	}

	public getSession(): ReviewSession | undefined {
		return this.session;
	}

	public getReviewFiles(): readonly ReviewFile[] {
		return this.session?.files ?? [];
	}

	public getOriginalText(uri: vscode.Uri): string | undefined {
		const fileId = uri.query;
		const file = this.session?.files.find(f => f.id === fileId);
		if (!file) {
			return undefined;
		}

		const acceptedHunks = file.hunks.filter(h => h.state === 'accepted');
		if (acceptedHunks.length === 0) {
			return file.originalText;
		}

		// For accepted hunks, replace the original lines with proposed lines so the
		// diff editor shows no difference at those positions (decorator disappears).
		const { lines, trailingNewline } = splitLines(file.originalText);
		const workingLines = [...lines];

		for (const hunk of [...acceptedHunks].sort((a, b) => b.oldStart - a.oldStart)) {
			const startIndex = Math.max(0, hunk.oldStart - 1);
			const originalLines = hunk.originalText.split('\n');
			const proposedLines = hunk.proposedText.split('\n');
			workingLines.splice(startIndex, originalLines.length, ...proposedLines);
		}

		return joinLines(workingLines, trailingNewline);
	}

	public isExpanded(fileId: string): boolean {
		return this.session?.expandedFileIds.has(fileId) ?? true;
	}

	public getFileById(fileId: string): ReviewFile | undefined {
		return this.session?.files.find(file => file.id === fileId);
	}

	public getHunkById(hunkId: string): ReviewHunk | undefined {
		for (const file of this.session?.files ?? []) {
			const hunk = file.hunks.find(candidate => candidate.id === hunkId);
			if (hunk) {
				return hunk;
			}
		}

		return undefined;
	}

	public async openItem(item: ReviewFile | ReviewHunk): Promise<void> {
		if ('uri' in item) {
			await this.openFile(item);
			return;
		}

		const file = this.getFileById(item.fileId);
		if (!file) {
			return;
		}

		await this.openFile(file, item);
	}

	public async acceptHunk(hunk: ReviewHunk): Promise<void> {
		await this.ensureHunkApplicable(hunk, false);
		hunk.state = 'accepted';
		this.setActiveSelection(hunk.fileId, hunk.id);
		await this.saveSession();
		this.onDidChangeSessionEmitter.fire();
	}

	public async rejectHunk(hunk: ReviewHunk): Promise<void> {
		await this.ensureHunkApplicable(hunk, true);

		const file = this.getFileById(hunk.fileId);
		if (!file) {
			throw new Error('Unable to find file for hunk.');
		}

		const document = await vscode.workspace.openTextDocument(file.uri);
		const range = this.computeRejectRange(document, hunk);
		if (!range) {
			hunk.state = 'conflicted';
			await this.saveSession();
			this.onDidChangeSessionEmitter.fire();
			throw new Error('The workspace file no longer matches the proposed text for this hunk.');
		}

		const edit = new vscode.WorkspaceEdit();
		edit.replace(file.uri, range, hunk.originalText);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			throw new Error('VS Code rejected the workspace edit for this hunk.');
		}

		hunk.state = 'rejected';
		this.setActiveSelection(hunk.fileId, hunk.id);
		await this.revalidateFile(file.id);
	}

	public async inspectDeletedText(hunk: ReviewHunk): Promise<void> {
		const content = hunk.originalText.length > 0 ? hunk.originalText : '(No deleted text)';
		const document = await vscode.workspace.openTextDocument({ content, language: 'diff' });
		await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
	}

	public getCounts(file: ReviewFile): ReviewCounts {
		return file.hunks.reduce<ReviewCounts>((counts, hunk) => {
			counts[hunk.state] += 1;
			return counts;
		}, { pending: 0, accepted: 0, rejected: 0, conflicted: 0, stale: 0 });
	}

	public getOrderedHunks(): ReviewHunk[] {
		return this.session?.files.flatMap(file => file.hunks) ?? [];
	}

	public async goToAdjacentHunk(direction: 1 | -1): Promise<void> {
		const hunks = this.getOrderedHunks();
		if (hunks.length === 0) {
			return;
		}

		const currentId = this.session?.activeHunkId;
		const currentIndex = currentId ? hunks.findIndex(hunk => hunk.id === currentId) : -1;
		const targetIndex = currentIndex === -1
			? 0
			: Math.max(0, Math.min(hunks.length - 1, currentIndex + direction));
		const target = hunks[targetIndex];
		if (target) {
			await this.openItem(target);
		}
	}

	public setExpanded(fileId: string, expanded: boolean): void {
		if (!this.session) {
			return;
		}

		if (expanded) {
			this.session.expandedFileIds.add(fileId);
		} else {
			this.session.expandedFileIds.delete(fileId);
		}

		void this.saveSession();
	}

	public setActiveSelection(fileId: string | undefined, hunkId: string | undefined): void {
		if (!this.session) {
			return;
		}

		this.session.activeFileId = fileId;
		this.session.activeHunkId = hunkId;
		void this.saveSession();
	}

	private async createReviewFile(parsedFile: ParsedDiffFile, input: GitDiffReviewSessionInput, workspaceRoot: vscode.Uri): Promise<ReviewFile> {
		const identity = input.identity.files[parsedFile.path];
		if (!identity) {
			throw new Error(`Missing identity metadata for ${parsedFile.path}`);
		}

		if (identity.hunkIds.length !== parsedFile.hunks.length) {
			throw new Error(`Identity hunk count mismatch for ${parsedFile.path}`);
		}

		const uri = vscode.Uri.file(path.join(workspaceRoot.fsPath, parsedFile.path));
		const document = await vscode.workspace.openTextDocument(uri);
		const originalText = reconstructOriginalText(document.getText(), parsedFile.hunks);
		const originalUri = vscode.Uri.from({
			scheme: LATCH_REVIEW_ORIGINAL_SCHEME,
			path: uri.path,
			query: identity.fileId
		});
		const hunks = parsedFile.hunks.map((parsedHunk, index) => {
			const hunkId = identity.hunkIds[index];
			if (!hunkId) {
				throw new Error(`Missing hunk identity for ${parsedFile.path} at index ${index}`);
			}
			const kind = this.getHunkKind(parsedHunk.originalLines, parsedHunk.proposedLines);
			const anchorLine = this.getAnchorLine(parsedHunk, document.lineCount);
			const contextLine = Math.max(1, Math.min(document.lineCount === 0 ? 1 : document.lineCount, parsedHunk.newStart || parsedHunk.oldStart || 1));
			const hunk: ReviewHunk = {
				id: hunkId,
				fileId: identity.fileId,
				filePath: parsedFile.path,
				header: parsedHunk.header,
				kind,
				state: 'pending',
				oldStart: parsedHunk.oldStart,
				oldLineCount: parsedHunk.oldLineCount,
				newStart: parsedHunk.newStart,
				newLineCount: parsedHunk.newLineCount,
				displayOldStart: parsedHunk.displayOldStart,
				displayOldLineCount: parsedHunk.displayOldLineCount,
				displayNewStart: parsedHunk.displayNewStart,
				displayNewLineCount: parsedHunk.displayNewLineCount,
				displayNewBlockStarts: parsedHunk.displayNewBlockStarts,
				originalText: parsedHunk.originalLines.join('\n'),
				proposedText: parsedHunk.proposedLines.join('\n'),
				anchorLine,
				contextLine
			};
			return this.validateHunkAgainstDocument(hunk, document);
		});

		return {
			id: identity.fileId,
			path: parsedFile.path,
			uri,
			originalUri,
			originalText,
			hunks,
			conflicted: hunks.some(hunk => hunk.state === 'conflicted')
		};
	}

	private applyPersistedState(files: ReviewFile[], persisted?: PersistedReviewSession): void {
		if (!persisted) {
			return;
		}

		const stateById = new Map(persisted.hunkStates.map(state => [state.id, state.state]));
		for (const file of files) {
			for (const hunk of file.hunks) {
				const savedState = stateById.get(hunk.id);
				if (savedState && hunk.state !== 'conflicted') {
					hunk.state = savedState;
				}
			}

			file.conflicted = file.hunks.some(hunk => hunk.state === 'conflicted');
		}
	}

	private getHunkKind(originalLines: string[], proposedLines: string[]): ReviewHunkKind {
		if (originalLines.length === 0) {
			return 'insert';
		}

		if (proposedLines.length === 0) {
			return 'delete';
		}

		return 'replace';
	}

	private getAnchorLine(hunk: { newStart: number; newLineCount: number; displayNewStart: number; displayNewLineCount: number; oldStart: number }, lineCount: number): number {
		if (lineCount <= 0) {
			return 1;
		}

		if (hunk.displayNewLineCount > 0) {
			return Math.max(1, Math.min(lineCount, hunk.displayNewStart));
		}

		if (hunk.newStart <= lineCount) {
			return Math.max(1, hunk.newStart);
		}

		if (hunk.newStart - 1 <= lineCount) {
			return Math.max(1, hunk.newStart - 1);
		}

		return lineCount;
	}

	private validateHunkAgainstDocument(hunk: ReviewHunk, document: vscode.TextDocument): ReviewHunk {
		if (this.doesDocumentMatchProposedState(document, hunk)) {
			return hunk;
		}

		hunk.state = 'conflicted';
		return hunk;
	}

	private doesDocumentMatchProposedState(document: vscode.TextDocument, hunk: ReviewHunk): boolean {
		return this.findProposedRange(document, hunk) !== undefined;
	}

	private getProposedRange(document: vscode.TextDocument, hunk: ReviewHunk): vscode.Range | undefined {
		const startLine = Math.max(0, hunk.newStart - 1);
		if (startLine > document.lineCount) {
			return undefined;
		}

		if (hunk.newLineCount === 0) {
			const anchorLine = Math.min(startLine, Math.max(document.lineCount - 1, 0));
			const position = document.lineCount === 0
				? new vscode.Position(0, 0)
				: new vscode.Position(anchorLine, anchorLine === startLine ? 0 : document.lineAt(anchorLine).range.end.character);
			return new vscode.Range(position, position);
		}

		if (startLine + hunk.newLineCount > document.lineCount) {
			return undefined;
		}

		const start = new vscode.Position(startLine, 0);
		const lastLine = startLine + hunk.newLineCount - 1;
		const end = lastLine >= document.lineCount - 1
			? document.lineAt(document.lineCount - 1).range.end
			: document.lineAt(lastLine).range.end;
		return new vscode.Range(start, end);
	}

	private findProposedRange(document: vscode.TextDocument, hunk: ReviewHunk): vscode.Range | undefined {
		// Delete-only hunks have no proposed content to search for; use position-based range.
		if (hunk.newLineCount === 0) {
			return this.getProposedRange(document, hunk);
		}

		// Try the expected position first (fast path).
		const expectedRange = this.getProposedRange(document, hunk);
		if (expectedRange && document.getText(expectedRange) === hunk.proposedText) {
			return expectedRange;
		}

		// Fall back to scanning the document for the proposed text.
		// This handles cases where lines were added/deleted above the hunk,
		// shifting the content away from its original position.
		const firstProposedLine = hunk.proposedText.split('\n')[0] ?? '';
		const expectedStartLine = hunk.newStart - 1;
		let bestRange: vscode.Range | undefined;
		let bestDistance = Infinity;

		for (let i = 0; i <= document.lineCount - hunk.newLineCount; i++) {
			if (document.lineAt(i).text !== firstProposedLine) {
				continue;
			}

			const start = new vscode.Position(i, 0);
			const lastLineIdx = i + hunk.newLineCount - 1;
			const end = lastLineIdx >= document.lineCount - 1
				? document.lineAt(document.lineCount - 1).range.end
				: document.lineAt(lastLineIdx).range.end;
			const range = new vscode.Range(start, end);

			if (document.getText(range) === hunk.proposedText) {
				const distance = Math.abs(i - expectedStartLine);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestRange = range;
				}
			}
		}

		return bestRange;
	}

	private computeRejectRange(document: vscode.TextDocument, hunk: ReviewHunk): vscode.Range | undefined {
		return this.findProposedRange(document, hunk);
	}

	private async ensureHunkApplicable(hunk: ReviewHunk, requireProposedMatch: boolean): Promise<void> {
		if (hunk.state === 'conflicted') {
			throw new Error('This hunk is conflicted and cannot be applied.');
		}

		const file = this.getFileById(hunk.fileId);
		if (!file) {
			throw new Error('Unable to find file for hunk.');
		}

		const document = await vscode.workspace.openTextDocument(file.uri);
		const matches = this.doesDocumentMatchProposedState(document, hunk);
		if (requireProposedMatch && !matches) {
			hunk.state = 'conflicted';
			await this.saveSession();
			this.onDidChangeSessionEmitter.fire();
			throw new Error('The workspace file no longer matches the proposed state.');
		}

		if (!requireProposedMatch && !matches) {
			hunk.state = 'conflicted';
			await this.saveSession();
			this.onDidChangeSessionEmitter.fire();
			throw new Error('The workspace file no longer matches the proposed state.');
		}
	}

	private async openFile(file: ReviewFile, hunk?: ReviewHunk): Promise<void> {
		const config = vscode.workspace.getConfiguration('diffEditor');
		if (!config.get<boolean>('codeLens')) {
			await config.update('codeLens', true, vscode.ConfigurationTarget.Global);
		}

		const targetLine = hunk
			? Math.max(1, hunk.kind === 'delete' ? hunk.anchorLine : hunk.displayNewStart)
			: 1;
		const selection = new vscode.Range(targetLine - 1, 0, targetLine - 1, 0);
		const titleSuffix = this.session?.title ? ` (${this.session.title})` : '';
		const diffOptions = {
			preview: false,
			preserveFocus: false,
			selection,
			renderSideBySide: false
		};
		await vscode.commands.executeCommand(
			'vscode.diff',
			file.originalUri,
			file.uri,
			`${path.basename(file.path)}${titleSuffix}`,
			diffOptions
		);

		if (hunk) {
			this.setActiveSelection(file.id, hunk.id);
		} else {
			this.setActiveSelection(file.id, this.session?.activeHunkId);
		}
	}

	private async revalidateFile(fileId: string): Promise<void> {
		const file = this.getFileById(fileId);
		if (!file) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(file.uri);
		for (const hunk of file.hunks) {
			if (hunk.state === 'rejected') {
				continue;
			}

			if (this.doesDocumentMatchProposedState(document, hunk)) {
				if (hunk.state === 'stale') {
					hunk.state = 'pending';
				}
			} else if (hunk.state === 'accepted') {
				hunk.state = 'conflicted';
			} else {
				hunk.state = 'stale';
			}
		}

		file.conflicted = file.hunks.some(hunk => hunk.state === 'conflicted');
		await this.saveSession();
		this.onDidChangeSessionEmitter.fire();
	}

	private async handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const file = this.session?.files.find(candidate => candidate.uri.toString() === event.document.uri.toString());
		if (!file) {
			return;
		}

		await this.revalidateFile(file.id);
	}

	private refreshWatchers(): void {
		for (const watcher of this.fileWatchers.values()) {
			watcher.dispose();
		}
		this.fileWatchers.clear();

		for (const file of this.session?.files ?? []) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file.uri.fsPath), path.basename(file.uri.fsPath)));
			this.fileWatchers.set(file.id, watcher);
			this.disposables.push(watcher);
		}
	}

	private async saveSession(): Promise<void> {
		if (!this.session || !this.persistedInput) {
			await this.context.workspaceState.update(STORAGE_KEY, undefined);
			return;
		}

		const persisted: PersistedReviewSession = {
			input: this.persistedInput,
			activeFileId: this.session.activeFileId,
			activeHunkId: this.session.activeHunkId,
			expandedFileIds: [...this.session.expandedFileIds],
			hunkStates: this.session.files.flatMap(file => file.hunks.map(hunk => ({ id: hunk.id, state: hunk.state })))
		};
		await this.context.workspaceState.update(STORAGE_KEY, persisted);
	}

	public dispose(): void {
		for (const watcher of this.fileWatchers.values()) {
			watcher.dispose();
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
