import { ParsedDiffFile, ParsedHunk, ParsedHunkBlock } from '../types';

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

interface CurrentBlock {
	oldStart: number;
	newStart: number;
	originalLines: string[];
	proposedLines: string[];
}

function finalizeBlock(currentBlock: CurrentBlock, currentHunk: ParsedHunk): void {
	if (currentBlock.originalLines.length === 0 && currentBlock.proposedLines.length === 0) {
		return;
	}
	const block: ParsedHunkBlock = {
		oldStart: currentBlock.oldStart,
		oldLineCount: currentBlock.originalLines.length,
		newStart: currentBlock.newStart,
		newLineCount: currentBlock.proposedLines.length,
		originalLines: [...currentBlock.originalLines],
		proposedLines: [...currentBlock.proposedLines]
	};
	currentHunk.blocks.push(block);
	currentBlock.originalLines.length = 0;
	currentBlock.proposedLines.length = 0;
}

export function parseGitDiff(diffText: string): ParsedDiffFile[] {
	const lines = diffText.split(/\r?\n/);
	const files: ParsedDiffFile[] = [];
	let currentFile: ParsedDiffFile | undefined;
	let currentHunk: ParsedHunk | undefined;
	let hunkCurrentNewLine = 0;
	let hunkCurrentOldLine = 0;
	let hunkInChangeBlock = false;
	let currentBlock: CurrentBlock | undefined;

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			if (currentHunk && currentFile) {
				if (currentBlock) { finalizeBlock(currentBlock, currentHunk); }
				currentFile.hunks.push(currentHunk);
			}
			currentHunk = undefined;
			currentFile = undefined;
			currentBlock = undefined;
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
				if (currentBlock) { finalizeBlock(currentBlock, currentHunk); }
				currentFile.hunks.push(currentHunk);
			}

			const oldStart = match[1];
			const newStart = match[3];
			if (oldStart === undefined || newStart === undefined) {
				throw new Error(`Invalid hunk header: ${line}`);
			}
			const newStartNum = Number.parseInt(newStart, 10);
			const oldStartNum = Number.parseInt(oldStart, 10);
			hunkCurrentNewLine = newStartNum;
			hunkCurrentOldLine = oldStartNum;
			hunkInChangeBlock = false;
			currentBlock = undefined;
			currentHunk = {
				oldStart: oldStartNum,
				oldLineCount: parseCount(match[2]),
				newStart: newStartNum,
				newLineCount: parseCount(match[4]),
				displayOldStart: oldStartNum,
				displayOldLineCount: 0,
				displayNewStart: newStartNum,
				displayNewLineCount: 0,
				displayNewBlockStarts: [],
				header: (match[5] ?? '').trim(),
				originalLines: [],
				proposedLines: [],
				blocks: []
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
				currentBlock = { oldStart: hunkCurrentOldLine, newStart: hunkCurrentNewLine, originalLines: [], proposedLines: [] };
			}
			if (currentHunk.displayOldLineCount === 0) {
				currentHunk.displayOldStart = currentHunk.oldStart + currentHunk.originalLines.length;
			}
			currentHunk.originalLines.push(line.slice(1));
			currentBlock!.originalLines.push(line.slice(1));
			currentHunk.displayOldLineCount += 1;
			hunkCurrentOldLine += 1;
			continue;
		}

		if (line.startsWith('+')) {
			if (!hunkInChangeBlock) {
				hunkInChangeBlock = true;
				currentHunk.displayNewBlockStarts.push(hunkCurrentNewLine);
				currentBlock = { oldStart: hunkCurrentOldLine, newStart: hunkCurrentNewLine, originalLines: [], proposedLines: [] };
			}
			if (currentHunk.displayNewLineCount === 0) {
				currentHunk.displayNewStart = currentHunk.newStart + currentHunk.proposedLines.length;
			}
			currentHunk.proposedLines.push(line.slice(1));
			currentBlock!.proposedLines.push(line.slice(1));
			currentHunk.displayNewLineCount += 1;
			hunkCurrentNewLine += 1;
			continue;
		}

		if (line.startsWith(' ')) {
			if (hunkInChangeBlock && currentBlock) {
				finalizeBlock(currentBlock, currentHunk);
				currentBlock = undefined;
			}
			hunkInChangeBlock = false;
			hunkCurrentNewLine += 1;
			hunkCurrentOldLine += 1;
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
		if (currentBlock) { finalizeBlock(currentBlock, currentHunk); }
		currentFile.hunks.push(currentHunk);
	}

	return files.filter(file => file.hunks.length > 0);
}
