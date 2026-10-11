/** Apply ND's Windows console policy to Node wrappers and their descendants. */
export function backgroundProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  preloadPath: string,
  platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return environment
  const requirement = `--require ${JSON.stringify(preloadPath)}`
  const existing = environment.NODE_OPTIONS?.trim() ?? ''
  return {
    ...environment,
    NODE_OPTIONS: existing.includes(requirement) ? existing : `${existing} ${requirement}`.trim(),
  }
}
