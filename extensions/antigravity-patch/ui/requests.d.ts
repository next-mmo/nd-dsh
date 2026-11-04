export type PatchOperation = 'help' | 'status' | 'apply' | 'reset' | 'adopt'
export function patchRequest(operation: PatchOperation, dryRun?: boolean): string
export function patchPreview(operation: PatchOperation, dryRun?: boolean): string
