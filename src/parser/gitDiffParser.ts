import { ParsedDiffFile, ParsedHunk } from '../types';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseCount(value: string | undefined): number {
	return value === undefined ? 1 : Number.parseInt(value, 10);
}

function normalizePath(rawPath: string): string {
	if (rawPath.startsWith('a/') || rawPath.startsWith('b/')) {
		return rawPath.slice(2);
	}

	return rawPath;
}

export function parseGitDiff(diffText: string): ParsedDiffFile[] {
	const lines = diffText.split(/\r?\n/);
	const files: ParsedDiffFile[] = [];
	let currentFile: ParsedDiffFile | undefined;
	let currentHunk: ParsedHunk | undefined;
	let hunkCurrentNewLine = 0;
	let hunkInChangeBlock = false;

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			if (currentHunk && currentFile) {
				currentFile.hunks.push(currentHunk);
			}
			currentHunk = undefined;
			currentFile = undefined;
			continue;
		}

		if (line.startsWith('+++ ')) {
			const rawPath = line.slice(4).trim();
			if (rawPath === '/dev/null') {
				continue;
			}

			currentFile = { path: normalizePath(rawPath), hunks: [] };
			files.push(currentFile);
			continue;
		}

		const match = line.match(HUNK_HEADER);
		if (match) {
			if (!currentFile) {
				throw new Error('Encountered a hunk before a file path.');
			}

			if (currentHunk) {
				currentFile.hunks.push(currentHunk);
			}

			const oldStart = match[1];
			const newStart = match[3];
			if (oldStart === undefined || newStart === undefined) {
				throw new Error(`Invalid hunk header: ${line}`);
			}
			const newStartNum = Number.parseInt(newStart, 10);
			hunkCurrentNewLine = newStartNum;
			hunkInChangeBlock = false;
			currentHunk = {
				oldStart: Number.parseInt(oldStart, 10),
				oldLineCount: parseCount(match[2]),
				newStart: newStartNum,
				newLineCount: parseCount(match[4]),
				displayOldStart: Number.parseInt(oldStart, 10),
				displayOldLineCount: 0,
				displayNewStart: newStartNum,
				displayNewLineCount: 0,
				displayNewBlockStarts: [],
				header: (match[5] ?? '').trim(),
				originalLines: [],
				proposedLines: []
			};
			continue;
		}

		if (!currentHunk) {
			continue;
		}

		if (line.startsWith('-')) {
			if (!hunkInChangeBlock) {
				hunkInChangeBlock = true;
				currentHunk.displayNewBlockStarts.push(hunkCurrentNewLine);
			}
			if (currentHunk.displayOldLineCount === 0) {
				currentHunk.displayOldStart = currentHunk.oldStart + currentHunk.originalLines.length;
			}
			currentHunk.originalLines.push(line.slice(1));
			currentHunk.displayOldLineCount += 1;
			continue;
		}

		if (line.startsWith('+')) {
			if (!hunkInChangeBlock) {
				hunkInChangeBlock = true;
				currentHunk.displayNewBlockStarts.push(hunkCurrentNewLine);
			}
			if (currentHunk.displayNewLineCount === 0) {
				currentHunk.displayNewStart = currentHunk.newStart + currentHunk.proposedLines.length;
			}
			currentHunk.proposedLines.push(line.slice(1));
			currentHunk.displayNewLineCount += 1;
			hunkCurrentNewLine += 1;
			continue;
		}

		if (line.startsWith(' ')) {
			hunkInChangeBlock = false;
			hunkCurrentNewLine += 1;
			const value = line.slice(1);
			currentHunk.originalLines.push(value);
			currentHunk.proposedLines.push(value);
			continue;
		}

		if (line === '\\ No newline at end of file') {
			continue;
		}
	}

	if (currentHunk && currentFile) {
		currentFile.hunks.push(currentHunk);
	}

	return files.filter(file => file.hunks.length > 0);
}
