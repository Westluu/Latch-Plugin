import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { parseGitDiff } from '../parser/gitDiffParser';

const execFileAsync = promisify(execFile);

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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
	if (candidate !== undefined) {
		try {
			if (parseGitDiff(candidate).length > 0) {
				return candidate;
			}
		} catch (error) {
			throw new Error(`Unable to parse the provided git diff payload: ${getErrorMessage(error)}`);
		}

		throw new Error('The provided git diff payload did not contain any file hunks.');
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		throw new Error('No workspace folder is open.');
	}

	const gitDiff = await readGitDiffFromFolder(workspaceFolder).catch(error => {
		throw new Error(`Unable to read git diff from ${workspaceFolder.name}: ${getErrorMessage(error)}`);
	});

	try {
		if (parseGitDiff(gitDiff).length > 0) {
			return gitDiff;
		}
	} catch (error) {
		throw new Error(`Unable to parse the current workspace git diff from ${workspaceFolder.name}: ${getErrorMessage(error)}`);
	}

	throw new Error(`The current workspace git diff from ${workspaceFolder.name} did not contain any file hunks.`);
}
