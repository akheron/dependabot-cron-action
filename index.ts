import { getInput, setFailed } from '@actions/core'
import { getOctokit } from '@actions/github'
import { diff } from 'semver'

type Octokit = ReturnType<typeof getOctokit>
type MergeMethod = 'merge' | 'squash' | 'rebase'

const debug = (message: string | Error) => {
  if (getInput('debug')) {
    console.log('DEBUG', message)
  }
}

const debugJSON = (data: any) => debug(JSON.stringify(data, null, 2))

const info = (message: string) => console.log(message)

const error = (err: Error) => {
  console.error('ERROR:')
  console.error(err)
  setFailed(err.message)
}

const getAutoMerge = (value: string): 'major' | 'minor' | 'patch' => {
  const autoMerge = value || 'minor'
  if (autoMerge !== 'major' && autoMerge !== 'minor' && autoMerge !== 'patch')
    throw new Error(`Invalid auto-merge option: ${autoMerge}`)
  return autoMerge
}

const getMergeMethod = (value: string): MergeMethod => {
  const mergeMethod = value || 'merge'
  if (
    mergeMethod !== 'merge' &&
    mergeMethod !== 'squash' &&
    mergeMethod !== 'rebase'
  )
    throw new Error(`Invalid merge method: ${mergeMethod}`)
  return mergeMethod
}

const getSemver = (prTitle: string): string | null => {
  try {
    const fromVersion = prTitle
      .split('from ')[1]
      .split(' ')[0]
      .split('\n')[0]
      .substr(0, 8)
      .trim()
    const toVersion = prTitle
      .split(' to ')[1]
      .split(' ')[0]
      .split('\n')[0]
      .substr(0, 8)
      .trim()
    debug(
      `Get versions from ${prTitle} => from version ${fromVersion} to version ${toVersion}`
    )
    if (fromVersion && toVersion) {
      return diff(fromVersion, toVersion)
    }
  } catch (_err) {
    // empty
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
  } catch (err) {
    info(`Approve failed: ${err.message}`)
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
  try {
    await octokit.rest.pulls.merge({
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      merge_method: options.mergeMethod,
    })
    return true
  } catch (err) {
    info(`Merge failed: ${err.message}`)
    debug(err)
    return false
  }
}

const run = async () => {
  const token = getInput('token') || process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error('GitHub token not found; set the `token` parameter')
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/')
  const prAuthor = getInput('pr-author') || 'dependabot[bot]'
  const octokit = getOctokit(token)
  const autoMerge = getAutoMerge(getInput('auto-merge'))
  const mergeMethod = getMergeMethod(getInput('merge-method'))

  const pullRequests = (
    await octokit.rest.pulls.list({ owner, repo, state: 'open' })
  ).data.filter((pr) => pr.user?.login === prAuthor)

  info(`Found ${pullRequests.length} matching pull requests`)

  for (const pr of pullRequests) {
    const prNumber = pr.number
    const prTitle = pr.title

    info(`Processing PR ${prNumber}: ${prTitle}`)
    const lastCommitHash = pr._links.statuses.href.split('/').pop() || ''
    const checkRuns = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: lastCommitHash,
    })

    const allChecksHaveSucceeded = checkRuns.data.check_runs.every(
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
    const uniqueStatuses = statuses.data.filter(
      (item, index, self) =>
        self.map((i) => i.context).indexOf(item.context) === index
    )
    const allStatusesHaveSucceeded = uniqueStatuses.every(
      (run) => run.state === 'success'
    )
    if (!allStatusesHaveSucceeded) {
      info('All statuses did not succeed')
      debugJSON(statuses.data)
      continue
    }

    const versionBump = getSemver(pr.title)
    info(`Version bump: ${versionBump}`)

    if (
      (versionBump === 'major' && autoMerge === 'major') ||
      (versionBump === 'minor' &&
        (autoMerge === 'major' || autoMerge === 'minor')) ||
      (versionBump !== 'major' && versionBump !== 'minor')
    ) {
      info('Approve and merge')
      await approve(octokit, { owner, repo, prNumber })
      await merge(octokit, { owner, repo, prNumber, mergeMethod })
    } else {
      info(`Not merging ${versionBump}`)
    }
  }
}

run().catch(error)
