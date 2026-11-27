import { acquireLocalWorkload } from './local-workload.mjs'

export default function setup() {
  return acquireLocalWorkload('Vitest')
}
