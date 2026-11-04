const requests = {
  help: '-h',
  status: 'status',
  apply: 'apply',
  reset: 'reset',
  adopt: 'adopt',
}

/** Only prepares instruction text. Execution belongs to the ND skill after Send. */
export function patchRequest(operation, dryRun = true) {
  if (!Object.hasOwn(requests, operation)) throw new Error('Choose a patch operation')
  const previewable = ['apply', 'reset', 'adopt'].includes(operation)
  return requests[operation] + (previewable && dryRun ? ' --dry-run' : '')
}

export function patchPreview(operation, dryRun = true) {
  return '/antigravity-patch ' + patchRequest(operation, dryRun)
}
