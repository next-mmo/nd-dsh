import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// All checkouts for this user contend on the same OS file lock. SQLite
// releases it on process death, including taskkill, with no PID-file recovery.
export function acquireLocalWorkload(job, directory = join(homedir(), '.nd-dsh')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'local-workload.sqlite'))
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if (error.errcode === 5) {
      throw new Error(`Cannot start ${job} while another ND build or test is running. Wait for it to finish.`, { cause: error })
    }
    throw error
  }
  const release = () => {
    process.off('exit', release)
    if (db.isOpen) db.close()
  }
  process.once('exit', release)
  return release
}

// A driver may die before its finally block closes Electron. Let the app
// shut down its own agents and keep the lock until its process actually exits.
export function watchTestDriver(pid, quit) {
  const watchdog = setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        clearInterval(watchdog)
        quit()
      }
    }
  }, 5000)
  watchdog.unref()
}
