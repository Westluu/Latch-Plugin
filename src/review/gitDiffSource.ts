import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { parseGitDiff } from '../parser/gitDiffParser';

const execFileAsync = promisify(execFile);

async function readGitDiffFromFolder(folder: vscode.WorkspaceFolder): Promise<string> {
	const primary = await execFileAsync('git', ['diff', '--no-ext-diff', '--relative'], {
		cwd: folder.uri.fsPath,
		maxBuffer: 10 * 1024 * 1024
	});

	if (primary.stdout.trim().length > 0) {
		return primary.stdout;
	}

	const staged = await execFileAsync('git', ['diff', '--cached', '--no-ext-diff', '--relative'], {
		cwd: folder.uri.fsPath,
		maxBuffer: 10 * 1024 * 1024
	});

	return staged.stdout;
}

export async function resolveGitDiffText(candidate: string | undefined): Promise<string> {
	if (candidate && parseGitDiff(candidate).length > 0) {
		return candidate;
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		throw new Error('No workspace folder is open.');
	}

	try {
		const gitDiff = await readGitDiffFromFolder(workspaceFolder);
		if (parseGitDiff(gitDiff).length > 0) {
			return gitDiff;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read git diff from ${workspaceFolder.name}: ${message}`);
	}

	throw new Error('No git diff with file hunks was found in the current workspace.');
}
