import { getInput, setFailed } from '@actions/core'
import { getOctokit } from '@actions/github'
import { diff } from 'semver'

type Octokit = ReturnType<typeof getOctokit>
type MergeMethod = 'merge' | 'squash' | 'rebase'

const debug = (message: string | Error) => {
  if (getInput('debug') === 'debug') {
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
    debug(prTitle)
    debug(`=> from version ${fromVersion} to version ${toVersion}`)
    if (fromVersion && toVersion) {
      return diff(fromVersion, toVersion)
    }
  } catch (_err) {}
  return null
}

const approve = async (
  octokit: Octokit,
  options: {
    owner: string
    repo: string
    prNumber: number
  }
): Promise<void> => {
  try {
    await octokit.pulls.createReview({
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      event: 'APPROVE',
    })
  } catch (error) {}
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
    await octokit.pulls.merge({
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      merge_method: options.mergeMethod,
    })
    return true
  } catch (err) {
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
    await octokit.pulls.list({ owner, repo, state: 'open' })
  ).data.filter((pr) => pr.user?.login === prAuthor)

  debug(`Found ${pullRequests.length} matching pull requests`)

  for (const pr of pullRequests) {
    const prNumber = pr.number
    const prTitle = pr.title

    debug(`Processing PR ${prNumber}: ${prTitle}`)
    const lastCommitHash = pr._links.statuses.href.split('/').pop() || ''
    const checkRuns = await octokit.checks.listForRef({
      owner,
      repo,
      ref: lastCommitHash,
    })

    const allChecksHaveSucceeded = checkRuns.data.check_runs.every(
      (run) => run.conclusion === 'success'
    )
    if (!allChecksHaveSucceeded) {
      info('All checks did not succeed')
      debugJSON(checkRuns.data)
      continue
    }

    const statuses = await octokit.repos.listCommitStatusesForRef({
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
      info(`Approve and merge`)
      await approve(octokit, { owner, repo, prNumber })
      await merge(octokit, { owner, repo, prNumber, mergeMethod })
    }
  }
}

run().catch(error)
