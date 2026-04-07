import { ParsedHunk } from '../types';

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
	const normalized = normalizeText(text);
	if (normalized.length === 0) {
		return { lines: [], trailingNewline: false };
	}

	const trailingNewline = normalized.endsWith('\n');
	const parts = normalized.split('\n');
	if (trailingNewline) {
		parts.pop();
	}

	return { lines: parts, trailingNewline };
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
	const text = lines.join('\n');
	return trailingNewline ? `${text}\n` : text;
}

export function reconstructOriginalText(currentText: string, hunks: ParsedHunk[]): string {
	const { lines, trailingNewline } = splitLines(currentText);
	const workingLines = [...lines];

	for (const hunk of [...hunks].reverse()) {
		const startIndex = Math.max(0, hunk.newStart - 1);
		const actual = workingLines.slice(startIndex, startIndex + hunk.newLineCount);
		const expected = hunk.proposedLines;
		if (actual.join('\n') !== expected.join('\n')) {
			throw new Error(`Current workspace text does not match the proposed patch at new range ${hunk.newStart},${hunk.newLineCount}.`);
		}

		workingLines.splice(startIndex, hunk.newLineCount, ...hunk.originalLines);
	}

	return joinLines(workingLines, trailingNewline);
}
