import { canPushToRepository } from '../adapters/github/github-collaborators.js';
import type { GitHubDeliveryReader } from '../adapters/github/github-delivery.js';
import {
  getPullRequestHead,
  getPullRequestState,
  listOpenPullRequests,
  markPullRequestReadyForReview,
} from '../adapters/github/github-pull-requests.js';
import { postCommentReaction } from '../adapters/github/github-reactions.js';
import { type AppConfig, resolveGitHubTokenEnv } from '../config.js';
import { logger } from '../platform/logger.js';
import { minutes, nowMs } from '../platform/time.js';
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

// AUTHOR_ACCESS_TTL_MS is how long an author's access is cached, so a permission change takes
// effect within it.
const AUTHOR_ACCESS_TTL_MS = minutes(5);

// GitHubPullRequests is what the machines, and the reading of a delivery, ask of GitHub
// about a pull request. A GitHub it cannot read is answered as open with nothing to do,
// which leaves the instance where it is; a write it could not make comes back as an
// error, which is a state the machine can move to.
export class GitHubPullRequests
  implements
    GitHubReader,
    GitHubWriter,
    GitHubImplementationPrReader,
    GitHubCommentWriter,
    GitHubDeliveryReader
{
  private readonly log = logger.child('github-pull-requests');
  private readonly authorAccess = new Map<string, { canPush: boolean; expiresAtMs: number }>();

  constructor(
    private readonly config: AppConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = nowMs,
  ) {}

  // authorCanPush keeps each answer for a while, because one person writes many comments;
  // a lookup that failed is not kept, so the next comment asks again.
  async authorCanPush(repositoryFullName: string, login: string): Promise<boolean> {
    const key = `${repositoryFullName}:${login}`.toLowerCase();
    const known = this.authorAccess.get(key);
    if (known && known.expiresAtMs > this.now()) return known.canPush;
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
    if (!token) {
      this.cannotAsk('author access', repositoryFullName, login, 'missing_token');
      return false;
    }
    try {
      const canPush = await canPushToRepository({
        repo: repositoryFullName,
        login,
        token,
        fetchImpl: this.fetchImpl,
      });
      this.authorAccess.set(key, { canPush, expiresAtMs: this.now() + AUTHOR_ACCESS_TTL_MS });
      return canPush;
    } catch (error: unknown) {
      this.cannotAsk(
        'author access',
        repositoryFullName,
        login,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async isForkPullRequest(repositoryFullName: string, pullRequestNumber: number): Promise<boolean> {
    const subject = `#${pullRequestNumber}`;
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
    if (!token) {
      this.cannotAsk('head repository', repositoryFullName, subject, 'missing_token');
      return true;
    }
    try {
      const head = await getPullRequestHead({
        repo: repositoryFullName,
        pullRequestNumber,
        token,
        fetchImpl: this.fetchImpl,
      });
      return head.fromFork;
    } catch (error: unknown) {
      this.cannotAsk(
        'head repository',
        repositoryFullName,
        subject,
        error instanceof Error ? error.message : String(error),
      );
      return true;
    }
  }

  async readPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<PullRequestSnapshot> {
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
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
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
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
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
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
    const token = this.env[resolveGitHubTokenEnv(this.config, repositoryFullName)];
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

  private cannotAsk(
    question: string,
    repositoryFullName: string,
    subject: string,
    reason: string,
  ): void {
    this.log.error(`cannot ask github for the ${question}`, {
      repository_full_name: repositoryFullName,
      subject,
      reason,
    });
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
