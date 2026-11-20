// Stand-in for @actions/core 1.10.0 setOutput, the version fetch-metadata v2.2.0
// bundles. toCommandValue is the conversion that function applies before the
// value is written to GITHUB_OUTPUT (null and undefined become '').
export const recorded = new Map()

export function setOutput (name, value) {
  recorded.set(name, toCommandValue(value))
}

export function info () {}
export function startGroup () {}
export function endGroup () {}

export function reset () {
  recorded.clear()
}

function toCommandValue (input) {
  if (input === null || input === undefined) {
    return ''
  } else if (typeof input === 'string' || input instanceof String) {
    return input
  }
  return JSON.stringify(input)
}
