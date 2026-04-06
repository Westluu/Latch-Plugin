import * as vscode from 'vscode';
import { ReviewCodeLensProvider } from './editor/reviewCodeLensProvider';
import { ReviewDecorationController } from './editor/reviewDecorationController';
import { parseGitDiff } from './parser/gitDiffParser';
import { resolveGitDiffText } from './review/gitDiffSource';
import { OriginalContentProvider, LATCH_REVIEW_ORIGINAL_SCHEME } from './review/originalContentProvider';
import { ReviewSessionService } from './review/reviewSessionService';
import { buildReviewSessionInputFromDiff } from './review/sessionInputFactory';
import { GitDiffReviewSessionInput, ReviewFile, ReviewHunk } from './types';
import { ReviewTreeDataProvider, ReviewTreeItem } from './views/reviewTreeDataProvider';

function asHunk(item: ReviewTreeItem | ReviewHunk | undefined, sessionService: ReviewSessionService): ReviewHunk | undefined {
	if (!item) {
		const activeId = sessionService.getSession()?.activeHunkId;
		return activeId ? sessionService.getHunkById(activeId) : undefined;
	}

	if ('uri' in item) {
		return undefined;
	}

	return item;
}

async function ensureDiffCodeLensVisible(): Promise<void> {
	const config = vscode.workspace.getConfiguration('diffEditor');
	if (config.get<boolean>('codeLens', true)) {
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		'Latch uses CodeLens in the native diff editor for Accept and Reject actions. Enable diff editor CodeLens?',
		'Enable',
		'Not Now'
	);
	if (choice === 'Enable') {
		await config.update('codeLens', true, vscode.ConfigurationTarget.Global);
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const sessionService = new ReviewSessionService(context);
	const originalContentProvider = new OriginalContentProvider(sessionService);
	const treeDataProvider = new ReviewTreeDataProvider(sessionService);
	const treeView = vscode.window.createTreeView('latch.review', { treeDataProvider, showCollapseAll: true });
	const decorationController = new ReviewDecorationController(sessionService);
	const codeLensProvider = new ReviewCodeLensProvider(sessionService);

	context.subscriptions.push(sessionService, treeView, decorationController, originalContentProvider);
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider));
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(LATCH_REVIEW_ORIGINAL_SCHEME, originalContentProvider));

	treeView.onDidExpandElement(event => sessionService.setExpanded((event.element as ReviewFile).id, true));
	treeView.onDidCollapseElement(event => sessionService.setExpanded((event.element as ReviewFile).id, false));

	context.subscriptions.push(vscode.commands.registerCommand('latch.startReviewSession', async (input?: GitDiffReviewSessionInput) => {
		let resolvedInput = input;
		if (!resolvedInput?.sessionId || resolvedInput.source?.kind !== 'gitDiff' || typeof resolvedInput.source.diffText !== 'string') {
			try {
				const diffText = await resolveGitDiffText(undefined);
				resolvedInput = buildReviewSessionInputFromDiff(diffText);
			} catch (error) {
				void vscode.window.showErrorMessage(
					error instanceof Error
						? `${error.message} Open a workspace with git changes or invoke latch.startReviewSession with a GitDiffReviewSessionInput payload.`
						: 'Open a workspace with git changes or invoke latch.startReviewSession with a GitDiffReviewSessionInput payload.'
				);
				return;
			}
		}

		await sessionService.startReviewSession(resolvedInput);
		await ensureDiffCodeLensVisible();
		treeDataProvider.refresh();
		decorationController.render();
		await vscode.commands.executeCommand('setContext', 'latch.hasReviewSession', true);
		const firstFile = sessionService.getReviewFiles()[0];
		if (firstFile) {
			await sessionService.openItem(firstFile.hunks[0] ?? firstFile);
		}
		if (!input) {
			void vscode.window.showInformationMessage('Started a Latch review session from the current workspace git diff.');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.resumeReviewSession', async () => {
		const restored = await sessionService.restoreSession();
		if (!restored) {
			void vscode.window.showInformationMessage('No Latch review session was found in workspace state.');
			return;
		}

		treeDataProvider.refresh();
		decorationController.render();
		await vscode.commands.executeCommand('setContext', 'latch.hasReviewSession', true);
		await ensureDiffCodeLensVisible();
		const activeFileId = sessionService.getSession()?.activeFileId;
		const activeItem = activeFileId
			? sessionService.getFileById(activeFileId)?.hunks.find(hunk => hunk.id === sessionService.getSession()?.activeHunkId)
				?? sessionService.getFileById(activeFileId)
			: sessionService.getReviewFiles()[0];
		if (activeItem) {
			await sessionService.openItem(activeItem);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.openReviewItem', async (item: ReviewTreeItem) => {
		await sessionService.openItem(item);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.inspectParsedGitDiff', async (diffText?: string) => {
		try {
			const sourceText = await resolveGitDiffText(diffText);
			const parsed = parseGitDiff(sourceText);
			if (parsed.length === 0) {
				void vscode.window.showWarningMessage('No file hunks were found in the current git diff.');
				return;
			}

			const document = await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify(parsed, null, 2)
			});
			await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
		} catch (error) {
			void vscode.window.showErrorMessage(
				error instanceof Error
					? `Failed to parse git diff: ${error.message}`
					: 'Failed to parse git diff.'
			);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.acceptHunk', async (item?: ReviewTreeItem | ReviewHunk) => {
		const hunk = asHunk(item, sessionService);
		if (!hunk) {
			return;
		}

		try {
			await sessionService.acceptHunk(hunk);
			treeDataProvider.refresh();
			decorationController.render();
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.rejectHunk', async (item?: ReviewTreeItem | ReviewHunk) => {
		const hunk = asHunk(item, sessionService);
		if (!hunk) {
			return;
		}

		try {
			await sessionService.rejectHunk(hunk);
			treeDataProvider.refresh();
			decorationController.render();
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.inspectDeletedText', async (item?: ReviewTreeItem | ReviewHunk) => {
		const hunk = asHunk(item, sessionService);
		if (!hunk) {
			return;
		}

		try {
			await sessionService.inspectDeletedText(hunk);
		} catch (error) {
			void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.nextHunk', async () => {
		await sessionService.goToAdjacentHunk(1);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('latch.previousHunk', async () => {
		await sessionService.goToAdjacentHunk(-1);
	}));

	const restored = await sessionService.restoreSession();
	await vscode.commands.executeCommand('setContext', 'latch.hasReviewSession', restored);
	if (restored) {
		treeDataProvider.refresh();
		decorationController.render();
	}
}

export function deactivate(): void {
	// Nothing to do.
}
