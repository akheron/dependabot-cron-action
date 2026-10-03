import { getInput, setFailed } from '@actions/core'
import { getOctokit } from '@actions/github'
import { diff, type ReleaseType } from 'semver'

type Octokit = ReturnType<typeof getOctokit>
type MergeMethod = 'merge' | 'squash' | 'rebase'

const DEFAULT_MERGE_METHOD = 'merge'
const DEFAULT_AUTO_MERGE = 'minor'
const DEFAULT_PR_AUTHOR = 'dependabot[bot]'
const RETRIES = 3
const RETRY_DELAY_MS = 1000

const debug = (err: unknown) => {
  if (getInput('debug')) {
    console.log('DEBUG', err)
  }
}

const debugJSON = (data: object) => debug(JSON.stringify(data, null, 2))

const info = (message: string) => console.log(message)

const error = (err: unknown) => {
  console.error('ERROR:')
  console.error(err)
  setFailed(getError(err))
}

const getError = (err: unknown) => {
  if (err instanceof Error) {
    return err.message
  }

  if (typeof err === 'string') {
    return err
  }

  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

const getAutoMerge = (value: string): 'major' | 'minor' | 'patch' => {
  const autoMerge = value || DEFAULT_AUTO_MERGE
  if (autoMerge !== 'major' && autoMerge !== 'minor' && autoMerge !== 'patch')
    throw new Error(`Invalid auto-merge option: ${autoMerge}`)
  return autoMerge
}

const getMergeMethod = (value: string): MergeMethod => {
  const mergeMethod = value || DEFAULT_MERGE_METHOD
  if (
    mergeMethod !== 'merge' &&
    mergeMethod !== 'squash' &&
    mergeMethod !== 'rebase'
  )
    throw new Error(`Invalid merge method: ${mergeMethod}`)
  return mergeMethod
}

const getVersionBumpFromTitle = (prTitle: string): ReleaseType | null => {
  const titleVersionRegex = /from\s+([^\s]+)\s+to\s+([^\s]+)/i
  const match = prTitle.match(titleVersionRegex)
  if (!match) {
    return null
  }

  const [, fromVersion, toVersion] = match
  debug(
    `Get versions from ${prTitle} => from version ${fromVersion} to version ${toVersion}`
  )

  try {
    return diff(fromVersion, toVersion)
  } catch {
    return null
  }
}

const getVersionBumpFromCommit = (
  commitMessage: string
): ReleaseType | null => {
  let bumpLevels: (ReleaseType | string | null)[]
  if (
    commitMessage
      .trim()
      .includes('These dependencies needed to be updated together.')
  ) {
    const fromToRegex =
      /Updates\s+`[^`]+`\s+from\s+(\d+\.\d+\.\d+)\s+to\s+(\d+\.\d+\.\d+)/g
    const matches = [...commitMessage.matchAll(fromToRegex)]

    if (matches.length === 0) {
      return null
    }

    bumpLevels = matches.map((match) => diff(match[1], match[2]))
  } else {
    const updateTypeRegex = /update-type:\s*version-update:semver-(\w+)/g
    const matches = [...commitMessage.matchAll(updateTypeRegex)]

    if (matches.length === 0) {
      return null
    }

    bumpLevels = matches.map((match) => match[1])
  }

  debug(`Found update types in commit: ${bumpLevels.join(', ')}`)

  // Return the highest bump level (major > minor > patch)
  if (bumpLevels.includes('major')) {
    return 'major'
  }
  if (bumpLevels.includes('minor')) {
    return 'minor'
  }
  if (bumpLevels.includes('patch')) {
    return 'patch'
  }

  return null
}

const approve = async (
  octokit: Octokit,
  options: {
    owner: string
    repo: string
    prNumber: number
  }
): Promise<boolean> => {
  try {
    await octokit.rest.pulls.createReview({
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      event: 'APPROVE',
    })
    return true
  } catch (err: unknown) {
    info(`Approve failed: ${getError(err)}`)
    debug(err)
    return false
  }
}

const merge = async (
  octokit: Octokit,
  options: {
    owner: string
    repo: string
    prNumber: number
    mergeMethod: MergeMethod
  }
): Promise<boolean> => {
  for (let i = 1; i <= RETRIES; i++) {
    try {
      await octokit.rest.pulls.merge({
        owner: options.owner,
        repo: options.repo,
        pull_number: options.prNumber,
        merge_method: options.mergeMethod,
      })
      return true
    } catch (err: unknown) {
      info(`Merge failed (attempt ${i}/${RETRIES}): ${getError(err)}`)
      debug(err)
      if (i < RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  return false
}

const run = async () => {
  const token = getInput('token') || process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error('GitHub token not found; set the `token` parameter')
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/')
  const prAuthor = getInput('pr-author') || DEFAULT_PR_AUTHOR
  const octokit = getOctokit(token)
  const autoMerge = getAutoMerge(getInput('auto-merge'))
  const mergeMethod = getMergeMethod(getInput('merge-method'))
  const useGitHubAutoMerge =
    getInput('skip-checks-for-auto-merge') === 'true' &&
    (
      await octokit.graphql<{
        repository: { autoMergeAllowed: boolean } | null
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) { autoMergeAllowed }
        }`,
        { owner, repo }
      )
    ).repository?.autoMergeAllowed === true

  const pullRequests = (
    await octokit.rest.pulls.list({ owner, repo, state: 'open' })
  ).data.filter((pr) => pr.user?.login === prAuthor)

  info(`Found ${pullRequests.length} matching pull requests`)

  for (const pr of pullRequests) {
    const prNumber = pr.number
    const prTitle = pr.title

    info(`Processing PR #${prNumber}: ${prTitle}`)
    if (!useGitHubAutoMerge) {
      const lastCommitHash = pr.head.sha
      const checkRuns = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: lastCommitHash,
      })

      const nonSkippedCheckRuns = checkRuns.data.check_runs.filter(
        (run) => run.conclusion !== 'skipped'
      )

      const checksWereRun = nonSkippedCheckRuns.length > 0
      if (!checksWereRun) {
        info('No checks were run')
        debugJSON(checkRuns.data)
        continue
      }

      const allChecksHaveSucceeded =
        checksWereRun &&
        nonSkippedCheckRuns.every(
          (run) => run.conclusion === 'success' || run.conclusion === 'neutral'
        )
      if (!allChecksHaveSucceeded) {
        info('All checks did not succeed')
        debugJSON(checkRuns.data)
        continue
      }

      const statuses = await octokit.rest.repos.listCommitStatusesForRef({
        owner,
        repo,
        ref: lastCommitHash,
      })
      const seenContexts = new Set<string>()
      const uniqueStatuses = statuses.data.filter((item) => {
        if (seenContexts.has(item.context)) {
          return false
        }

        seenContexts.add(item.context)
        return true
      })

      const allStatusesHaveSucceeded = uniqueStatuses.every(
        (run) => run.state === 'success'
      )
      if (!allStatusesHaveSucceeded) {
        info('All statuses did not succeed')
        debugJSON(statuses.data)
        continue
      }
    }

    // Try to get version bump from commit message metadata (works for grouped updates)
    const commits = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
    })
    const commitMessage = commits.data[0]?.commit?.message || ''
    let versionBump: ReleaseType | null =
      getVersionBumpFromCommit(commitMessage)

    // Fallback to parsing PR title (works for indirect security updates)
    if (!versionBump) {
      versionBump = getVersionBumpFromTitle(prTitle)
    }

    info(`Version bump: ${versionBump}`)

    if (
      (versionBump === 'major' && autoMerge === 'major') ||
      (versionBump === 'minor' &&
        (autoMerge === 'major' || autoMerge === 'minor')) ||
      versionBump === 'patch'
    ) {
      info('Approving and merging')
      if (await approve(octokit, { owner, repo, prNumber })) {
        info('Approved successfully')
        if (await merge(octokit, { owner, repo, prNumber, mergeMethod })) {
          info('Merged successfully')
        } else if (useGitHubAutoMerge) {
          if (pr.auto_merge) {
            info('GitHub auto-merge is already enabled')
            continue
          }
          try {
            await octokit.graphql(
              `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
                enablePullRequestAutoMerge(input: {
                  pullRequestId: $pullRequestId,
                  mergeMethod: $mergeMethod
                }) {
                  pullRequest { id }
                }
              }`,
              {
                pullRequestId: pr.node_id,
                mergeMethod: mergeMethod.toUpperCase(),
              }
            )
            info('GitHub auto-merge enabled; waiting for required conditions')
          } catch (err: unknown) {
            info(`Enabling GitHub auto-merge failed: ${getError(err)}`)
            debug(err)
          }
        }
      }
    } else {
      info(`Not merging ${versionBump}`)
    }
  }
}

run().catch(error)
