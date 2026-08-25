import {
  getPullRequestState,
  listOpenPullRequests,
  markPullRequestReadyForReview,
} from '../adapters/github/github-pull-requests.js';
import { postCommentReaction } from '../adapters/github/github-reactions.js';
import type { AppConfig } from '../config.js';
import { logger } from '../platform/logger.js';
import {
  type ExistingImplementationPr,
  matchOpenImplementationPr,
  type ProblemSignature,
} from '../workflows/pr/implementation-pr-dedup.js';
import type { GitHubImplementationPrReader } from './state-machines/fix-implementer/service.js';
import type { GitHubWriter } from './state-machines/linear-implementer/service.js';
import type {
  GitHubCommentWriter,
  GitHubReader,
  PickedUpComment,
  PullRequestSnapshot,
} from './state-machines/pr-maintainer/service.js';

// GitHubPullRequests is what the machines ask of GitHub about a pull request. A
// GitHub it cannot read is answered as open with nothing to do, which leaves the
// instance where it is; a write it could not make comes back as an error, which is a
// state the machine can move to.
export class GitHubPullRequests
  implements GitHubReader, GitHubWriter, GitHubImplementationPrReader, GitHubCommentWriter
{
  private readonly log = logger.child('github-pull-requests');

  constructor(
    private readonly config: AppConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async readPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<PullRequestSnapshot> {
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) return this.nothingToDo(repositoryFullName, pullRequestNumber, 'missing_token');
    try {
      return await getPullRequestState({
        repo: repositoryFullName,
        pullRequestNumber,
        token,
        fetchImpl: this.fetchImpl,
      });
    } catch (error: unknown) {
      return this.nothingToDo(
        repositoryFullName,
        pullRequestNumber,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async markReadyForReview(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<Error | undefined> {
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) return new Error('missing github token');
    try {
      await markPullRequestReadyForReview({
        repo: repositoryFullName,
        pullRequestNumber,
        token,
        fetchImpl: this.fetchImpl,
      });
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async markCommentPickedUp(
    repositoryFullName: string,
    comment: PickedUpComment,
  ): Promise<Error | undefined> {
    const reactions = this.config.workflows.prMaintainer.commentReactions;
    const commentId = Number(comment.commentExternalId);
    if (!reactions.enabled || !Number.isInteger(commentId)) return undefined;
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) return new Error('missing github token');
    try {
      await postCommentReaction({
        repo: repositoryFullName,
        commentType: comment.commentType,
        commentId,
        content: reactions.pickup,
        token,
        fetchImpl: this.fetchImpl,
      });
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async findOpenImplementationPullRequest(
    repositoryFullName: string,
    signature: ProblemSignature,
  ): Promise<ExistingImplementationPr | undefined> {
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) return this.cannotLookUp(repositoryFullName, signature, 'missing_token');
    try {
      const open = await listOpenPullRequests({
        repo: repositoryFullName,
        token,
        fetchImpl: this.fetchImpl,
      });
      return matchOpenImplementationPr(signature, open);
    } catch (error: unknown) {
      return this.cannotLookUp(
        repositoryFullName,
        signature,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // A lookup we could not make must not hold back a fix, so it answers no match.
  private cannotLookUp(
    repositoryFullName: string,
    signature: ProblemSignature,
    reason: string,
  ): undefined {
    this.log.error('cannot look up the open implementation pull requests', {
      repository_full_name: repositoryFullName,
      fingerprint: signature.fingerprint,
      reason,
    });
    return undefined;
  }

  // Open with nothing to act on leaves the instance where it is, which is the only
  // safe answer when we cannot see the pull request.
  private nothingToDo(
    repositoryFullName: string,
    pullRequestNumber: number,
    reason: string,
  ): PullRequestSnapshot {
    this.log.error('cannot read the pull request', {
      repository_full_name: repositoryFullName,
      pull_request_number: pullRequestNumber,
      reason,
    });
    return {
      state: 'open',
      headCommitSha: '',
      checksAreRed: false,
      hasUnresolvedReviewThreads: false,
    };
  }
}
