import { acquireLocalWorkload } from './local-workload.mjs'

acquireLocalWorkload('desktop build')
if (process.platform === 'win32') {
  process.env.RAYON_NUM_THREADS ??= '2'
  process.env.GOMAXPROCS ??= '2'
}
