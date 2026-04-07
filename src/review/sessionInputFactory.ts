import { createHash } from 'node:crypto';
import { parseGitDiff } from '../parser/gitDiffParser';
import { GitDiffReviewSessionInput } from '../types';

function createStableId(prefix: string, ...parts: string[]): string {
	const hash = createHash('sha1');
	for (const part of parts) {
		hash.update(part);
		hash.update('\0');
	}

	return `${prefix}-${hash.digest('hex').slice(0, 12)}`;
}

export function buildReviewSessionInputFromDiff(diffText: string, title?: string): GitDiffReviewSessionInput {
	const trimmedDiff = diffText.trim();
	if (trimmedDiff.length === 0) {
		throw new Error('The provided git diff is empty.');
	}

	const files = parseGitDiff(trimmedDiff);
	if (files.length === 0) {
		throw new Error('The provided git diff did not contain any file hunks.');
	}

	const sessionId = createStableId('session', trimmedDiff);
	const identity: GitDiffReviewSessionInput['identity'] = { files: {} };

	for (const file of files) {
		const fileId = createStableId('file', file.path);
		identity.files[file.path] = {
			fileId,
			hunkIds: file.hunks.flatMap((hunk, hunkIndex) =>
				hunk.blocks.map((block, blockIndex) => createStableId(
					'hunk',
					file.path,
					String(hunkIndex),
					String(blockIndex),
					hunk.header,
					String(block.oldStart),
					String(block.newStart),
					block.originalLines.join('\n'),
					block.proposedLines.join('\n')
				))
			)
		};
	}

	return {
		sessionId,
		title: title ?? 'Workspace Review',
		source: {
			kind: 'gitDiff',
			diffText: trimmedDiff
		},
		identity
	};
}
