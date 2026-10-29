/** ND Security contract. The security authority must run in trusted main/nd-core, not React. */
export type NdSecurityVerdict = 'verified' | 'blocked' | 'review-required'

export interface NdSecurityFinding {
  code: string
  severity: 'info' | 'warning' | 'critical'
  description: string
}
export interface NdSecurityReport {
  verdict: NdSecurityVerdict
  packageId: string
  version: string
  publisherKeyId: string
  sha256: string
  fileCount: number
  scannedAt: number
  findings: NdSecurityFinding[]
}
