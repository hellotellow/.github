/**
 * Spec for the Dependabot auto-merge reusable workflow.
 *
 * These tests fail while .github/workflows/auto-merge.yaml approves and
 * squash-merges an update whose fetch-metadata v2.2.0 update-type is missing,
 * or approves an update it classifies as minor or major. They pass when both
 * the approve step and the merge step run only for
 * version-update:semver-patch, and only against the pull request the metadata
 * action inspected.
 *
 * Run from tests/: npm install && npm test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import YAML from 'yaml'
import { parse } from './vendor/fetch-metadata-v2.2.0/update_metadata.ts'
import * as output from './vendor/fetch-metadata-v2.2.0/output.ts'
import * as core from './vendor/fetch-metadata-v2.2.0/actions-core-stub.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(root, '.github/workflows/auto-merge.yaml')
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'))

const EVENT_URL = 'https://github.com/example/app/pull/10'
const OTHER_URL = 'https://github.com/example/app/pull/99'

function loadFixture (name) {
  return readFileSync(join(root, 'tests/fixtures', name), 'utf8')
}

// commit_subject from dependabot-core message_builder.rb: a subject longer
// than 72 characters loses the " from <old> to <new>" span before it is
// committed. requirement_commit_message_intro then says only that the
// requirements were updated to permit the latest version.
function commitSubject (subject) {
  if (subject.length <= 72) return subject
  subject = subject.replace(/ from .+? to .+?(?= \(via audit fix\)| in \/|$)/, '')
  if (subject.length <= 72) return subject
  return subject.split(' in ')[0]
}

function requirementCommit (subject, name, newVersion) {
  return [
    subject,
    '',
    `Updates the requirements on [${name}](https://example.invalid/${name}) to permit the latest version.`,
    `- [Commits](https://example.invalid/${name}/compare/v1...v2)`,
    '',
    '---',
    'updated-dependencies:',
    `- dependency-name: ${name}`,
    `  dependency-version: ${newVersion}`,
    '  dependency-type: direct:production',
    '...',
    '',
    'Signed-off-by: dependabot[bot] <support@github.com>',
    ''
  ].join('\n')
}

// main.ts runs output.set only when parse returns at least one dependency.
// Otherwise the action calls setFailed and writes no outputs. maxSemver
// returns null for an empty update type, and setOutput stores that as ''.
async function classify (commitMessage, branchName) {
  core.reset()
  const dependencies = await parse(commitMessage, '', branchName, 'main')
  if (dependencies.length === 0) {
    return { failed: true, updateType: undefined }
  }
  output.set(dependencies)
  return { failed: false, updateType: core.recorded.get('update-type') }
}

function isFalsy (value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value === 0 || Number.isNaN(value)
  if (typeof value === 'string') return value === ''
  return false
}

function isTruthy (value) {
  return !isFalsy(value)
}

// String equality follows EvaluationResult.AbstractEqual: ordinal ignore case,
// no cross-kind match for two strings. != is the negation. && returns the
// first falsy operand or the last operand. A step runs when ConvertToIfResult
// sees IsTruthy.
function abstractEqual (left, right) {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase()
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right
  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left) || Number.isNaN(right)) return false
    return left === right
  }
  if ((left === null || left === undefined) && (right === null || right === undefined)) return true
  return false
}

function tokenize (expression) {
  const tokens = []
  let i = 0
  while (i < expression.length) {
    const c = expression[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      let value = ''
      i++
      while (i < expression.length) {
        if (expression[i] === "'") {
          if (expression[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += expression[i]
        i++
      }
      tokens.push({ type: 'string', value })
      continue
    }
    const two = expression.slice(i, i + 2)
    if (two === '!=' || two === '==' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two })
      i += 2
      continue
    }
    if (c === '!' || c === '(' || c === ')' || c === ',') {
      tokens.push({ type: c === '!' ? 'op' : c, value: c })
      i++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let value = c
      i++
      while (i < expression.length && /[A-Za-z0-9_-]/.test(expression[i])) {
        value += expression[i]
        i++
      }
      tokens.push({ type: 'ident', value })
      continue
    }
    if (c === '.') {
      tokens.push({ type: '.', value: '.' })
      i++
      continue
    }
    throw new Error(`Unsupported expression token ${JSON.stringify(c)} in ${expression}`)
  }
  return tokens
}

const PREC = { '||': 5, '&&': 6, '==': 10, '!=': 10, '!': 16 }

function parseExpression (expression) {
  const tokens = tokenize(expression)
  let index = 0
  const peek = () => tokens[index]
  const take = () => tokens[index++]

  function parsePrec (min) {
    let left = parseUnary()
    while (peek()?.type === 'op' && peek().value !== '!' && PREC[peek().value] >= min) {
      const op = take().value
      const right = parsePrec(PREC[op] + 1)
      left = { type: 'binary', op, left, right }
    }
    return left
  }

  function parseUnary () {
    if (peek()?.type === 'op' && peek().value === '!') {
      take()
      return { type: 'not', arg: parseUnary() }
    }
    return parseAtom()
  }

  function parseAtom () {
    const token = take()
    if (!token) throw new Error(`Unexpected end of expression: ${expression}`)
    if (token.type === 'string') return { type: 'string', value: token.value }
    if (token.type === '(') {
      const inner = parsePrec(0)
      if (take()?.type !== ')') throw new Error(`Unclosed '(' in ${expression}`)
      return inner
    }
    if (token.type !== 'ident') throw new Error(`Unexpected ${token.value} in ${expression}`)
    if (token.value === 'true') return { type: 'bool', value: true }
    if (token.value === 'false') return { type: 'bool', value: false }
    if (token.value === 'null') return { type: 'null' }
    if (peek()?.type === '(') {
      take()
      const args = []
      if (peek()?.type !== ')') {
        args.push(parsePrec(0))
        while (peek()?.type === ',') {
          take()
          args.push(parsePrec(0))
        }
      }
      if (take()?.type !== ')') throw new Error(`Unclosed call ${token.value} in ${expression}`)
      return { type: 'call', name: token.value, args }
    }
    const path = [token.value]
    while (peek()?.type === '.') {
      take()
      const prop = take()
      if (prop?.type !== 'ident') throw new Error(`Expected property in ${expression}`)
      path.push(prop.value)
    }
    return { type: 'path', path }
  }

  const ast = parsePrec(0)
  if (index !== tokens.length) throw new Error(`Trailing tokens in ${expression}`)
  return ast
}

function readPath (path, ctx) {
  let current = ctx
  for (const part of path) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

function evaluateAst (ast, ctx) {
  switch (ast.type) {
    case 'string':
    case 'bool':
      return ast.value
    case 'null':
      return null
    case 'path':
      return readPath(ast.path, ctx)
    case 'not':
      return !isTruthy(evaluateAst(ast.arg, ctx))
    case 'call': {
      const args = ast.args.map(arg => evaluateAst(arg, ctx))
      if (ast.name === 'success') return ctx.success === true
      if (ast.name === 'failure') return ctx.success === false
      if (ast.name === 'always') return true
      if (ast.name === 'cancelled') return false
      throw new Error(`Unsupported function ${ast.name}`)
    }
    case 'binary': {
      if (ast.op === '&&') {
        const left = evaluateAst(ast.left, ctx)
        if (isFalsy(left)) return left
        return evaluateAst(ast.right, ctx)
      }
      if (ast.op === '||') {
        const left = evaluateAst(ast.left, ctx)
        if (isTruthy(left)) return left
        return evaluateAst(ast.right, ctx)
      }
      const left = evaluateAst(ast.left, ctx)
      const right = evaluateAst(ast.right, ctx)
      const equal = abstractEqual(left, right)
      return ast.op === '==' ? equal : !equal
    }
    default:
      throw new Error(`Bad node ${ast.type}`)
  }
}

function unwrap (expression) {
  const match = String(expression).match(/^\s*\$\{\{\s*([\s\S]*?)\s*\}\}\s*$/)
  return match ? match[1] : String(expression)
}

// ConvertToIfCondition wraps a condition that does not already call a status
// function as success() && (<condition>). An omitted condition is success().
function stepCondition (rawIf) {
  if (rawIf === undefined || rawIf === null || String(rawIf).trim() === '') return 'success()'
  const inner = unwrap(rawIf)
  if (/\b(success|failure|always|cancelled)\s*\(/.test(inner)) return inner
  return `success() && (${inner})`
}

function evaluateCondition (rawIf, ctx) {
  return evaluateAst(parseExpression(stepCondition(rawIf)), ctx)
}

function evalTemplate (value, ctx) {
  if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value)
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression) => {
    const result = evaluateAst(parseExpression(expression), ctx)
    return result === null || result === undefined ? '' : String(result)
  })
}

function resolveScript (step, ctx) {
  const env = {}
  for (const [key, value] of Object.entries(step.env ?? {})) {
    env[key] = evalTemplate(value, ctx)
  }
  let script = evalTemplate(step.run ?? '', ctx)
  script = script.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name = braced || bare
    return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : match
  })
  return script
}

function sideEffects (script) {
  const effects = []
  for (const line of script.split('\n')) {
    if (/\bgh\s+pr\s+review\b/.test(line) && /--approve\b/.test(line)) {
      effects.push({ kind: 'approve', line })
    }
    if (/\bgh\s+pr\s+merge\b/.test(line) && /--auto\b/.test(line)) {
      effects.push({ kind: 'merge', line })
    }
  }
  return effects
}

function makeContext ({ actor, urlMode, updateType, metadataFailed }) {
  let reads = 0
  const inputs = new Proxy({}, {
    get (_target, property) {
      if (property !== 'pr-url') return undefined
      reads += 1
      if (urlMode === 'mismatch') return OTHER_URL
      if (urlMode === 'reread') return reads === 1 ? EVENT_URL : OTHER_URL
      return EVENT_URL
    }
  })
  const outputs = {}
  if (!metadataFailed && updateType !== undefined) outputs['update-type'] = updateType
  return {
    success: !metadataFailed,
    inputs,
    github: {
      actor,
      repository: 'example/app',
      server_url: 'https://github.com',
      event: {
        pull_request: {
          number: 10,
          html_url: EVENT_URL
        }
      }
    },
    steps: {
      'dependabot-metadata': { outputs }
    }
  }
}

async function runWorkflow ({ commitMessage, branch, actor = 'dependabot[bot]', urlMode = 'match' }) {
  const job = workflow.jobs.dependabot
  const classification = commitMessage === undefined
    ? { failed: true, updateType: undefined }
    : await classify(commitMessage, branch)
  const ctx = makeContext({
    actor,
    urlMode,
    updateType: classification.updateType,
    metadataFailed: classification.failed
  })
  if (!isTruthy(evaluateCondition(job.if, ctx))) {
    return { classification, effects: [] }
  }
  const effects = []
  let failed = false
  for (const step of job.steps) {
    ctx.success = !failed
    if (typeof step.uses === 'string' && step.uses.startsWith('dependabot/fetch-metadata@')) {
      if (classification.failed) failed = true
      continue
    }
    if (!isTruthy(evaluateCondition(step.if, ctx))) continue
    if (typeof step.run === 'string') {
      const script = resolveScript(step, ctx)
      for (const effect of sideEffects(script)) effects.push(effect)
    }
  }
  return { classification, effects }
}

function assertNoReviewSideEffects (effects) {
  assert.deepEqual(effects, [], `expected no approve or merge, got ${JSON.stringify(effects)}`)
}

function assertOnlyEventPullRequest (effects) {
  assert.ok(effects.length > 0, 'expected the patch update to be approved and merged')
  for (const effect of effects) {
    assert.ok(effect.line.includes(EVENT_URL), `${effect.kind} did not target the pull request the metadata action inspected: ${effect.line}`)
    assert.ok(!effect.line.includes(OTHER_URL), `${effect.kind} targeted a pull request the metadata action did not inspect: ${effect.line}`)
  }
  assert.ok(effects.some(effect => effect.kind === 'approve'))
  assert.ok(effects.some(effect => effect.kind === 'merge'))
}

test('expression denylist treats a missing update type as mergeable', () => {
  const condition = "steps.dependabot-metadata.outputs.update-type != 'version-update:semver-minor' && steps.dependabot-metadata.outputs.update-type != 'version-update:semver-major'"
  const ctxFor = updateType => ({
    success: true,
    steps: { 'dependabot-metadata': { outputs: { 'update-type': updateType } } }
  })
  assert.equal(isTruthy(evaluateAst(parseExpression(condition), ctxFor(''))), true)
  assert.equal(isTruthy(evaluateAst(parseExpression(condition), ctxFor('version-update:semver-patch'))), true)
  assert.equal(isTruthy(evaluateAst(parseExpression(condition), ctxFor('version-update:semver-minor'))), false)
  assert.equal(isTruthy(evaluateAst(parseExpression(condition), ctxFor('version-update:semver-major'))), false)
})

test('a truncated pip requirement moving 0.9 to 1.1 is not approved or merged', async () => {
  const message = loadFixture('pathspec-requirement.txt')
  assert.match(message, /compare\/v0\.9\.0\.\.\.v1\.1\.1/)
  assert.doesNotMatch(message.split('\n')[0], / from /)
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/pathspec-1.1.1'
  })
  assert.equal(result.classification.failed, false)
  assert.equal(result.classification.updateType, '')
  assertNoReviewSideEffects(result.effects)
})

test('a truncated pip requirement moving 2.0 to 2.8 is not approved or merged', async () => {
  const message = loadFixture('urllib3-requirement.txt')
  assert.match(message, /compare\/2\.0\.0\.\.\.2\.8\.0/)
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/urllib3-2.8.0'
  })
  assert.equal(result.classification.failed, false)
  assert.equal(result.classification.updateType, '')
  assertNoReviewSideEffects(result.effects)
})

test('a truncated pip requirement moving 0.29 to 0.31 is not approved or merged', async () => {
  const message = loadFixture('edk2-extensions-requirement.txt')
  assert.match(message, /compare\/v0\.29\.11\.\.\.v0\.31\.4/)
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/edk2-pytool-extensions-0.31.4'
  })
  assert.equal(result.classification.failed, false)
  assert.equal(result.classification.updateType, '')
  assertNoReviewSideEffects(result.effects)
})

test('a prefixed requirement line leaves even a patch unclassified and unmerged', async () => {
  const message = loadFixture('edk2-library-requirement.txt')
  assert.match(message.split('\n')[0], /^pip: update /)
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/edk2-pytool-library-0.23.18'
  })
  assert.equal(result.classification.failed, false)
  assert.equal(result.classification.updateType, '')
  assertNoReviewSideEffects(result.effects)
})

test('a 1.x to 2.x requirement whose subject was truncated is not approved or merged', async () => {
  const full = 'Update some-long-package-name requirement from >=1.2.3,<2.0.0 to >=2.0.0,<3.0.0'
  const subject = commitSubject(full)
  assert.equal(subject.includes('2.0.0'), false)
  const message = requirementCommit(subject, 'some-long-package-name', '2.0.0')
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/some-long-package-name-2.0.0'
  })
  assert.equal(result.classification.failed, false)
  assert.equal(result.classification.updateType, '')
  assertNoReviewSideEffects(result.effects)
})

test('a classified minor requirement is not approved or merged', async () => {
  const result = await runWorkflow({
    commitMessage: loadFixture('boto3-requirement.txt'),
    branch: 'dependabot/pip/boto3-1.44.4'
  })
  assert.equal(result.classification.updateType, 'version-update:semver-minor')
  assertNoReviewSideEffects(result.effects)
})

test('a classified major requirement is not approved or merged', async () => {
  const message = requirementCommit(
    'Update requests requirement from >=1.0,<2.0 to >=2.0,<3.0',
    'requests',
    '2.0.0'
  )
  const result = await runWorkflow({
    commitMessage: message,
    branch: 'dependabot/pip/requests-2.0.0'
  })
  assert.equal(result.classification.updateType, 'version-update:semver-major')
  assertNoReviewSideEffects(result.effects)
})

test('a classified patch is approved and merged only for the inspected pull request', async () => {
  const result = await runWorkflow({
    commitMessage: loadFixture('composer-patch-requirement.txt'),
    branch: 'dependabot/composer/yiisoft/definitions-3.4.2',
    urlMode: 'match'
  })
  assert.equal(result.classification.updateType, 'version-update:semver-patch')
  assertOnlyEventPullRequest(result.effects)
})

test('a caller-supplied pull request url is not approved or merged in place of the inspected pull request', async () => {
  const result = await runWorkflow({
    commitMessage: loadFixture('composer-patch-requirement.txt'),
    branch: 'dependabot/composer/yiisoft/definitions-3.4.2',
    urlMode: 'mismatch'
  })
  assert.equal(result.classification.updateType, 'version-update:semver-patch')
  assertOnlyEventPullRequest(result.effects)
})

test('using the caller url again after it matched the event retargets neither approve nor merge', async () => {
  const result = await runWorkflow({
    commitMessage: loadFixture('composer-patch-requirement.txt'),
    branch: 'dependabot/composer/yiisoft/definitions-3.4.2',
    urlMode: 'reread'
  })
  assert.equal(result.classification.updateType, 'version-update:semver-patch')
  assertOnlyEventPullRequest(result.effects)
})

test('a commit without dependency metadata does not approve or merge', async () => {
  const result = await runWorkflow({
    commitMessage: 'Bumps something from 1.0.0 to 1.0.1.\n',
    branch: 'dependabot/pip/something-1.0.1'
  })
  assert.equal(result.classification.failed, true)
  assertNoReviewSideEffects(result.effects)
})

test('a pull request that is not from Dependabot is not approved or merged', async () => {
  const result = await runWorkflow({
    commitMessage: loadFixture('composer-patch-requirement.txt'),
    branch: 'dependabot/composer/yiisoft/definitions-3.4.2',
    actor: 'human'
  })
  assertNoReviewSideEffects(result.effects)
})
