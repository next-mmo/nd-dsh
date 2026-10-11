import { describe, expect, it } from 'vitest'
import { normalizeProjectPlan } from '../src/main/organization/plan-normalizer.js'
import { mergeRepeatedArrayKeys } from '../src/shared/structured-output.js'

describe('mergeRepeatedArrayKeys', () => {
  it('preserves producer tasks when repeated task arrays have milestone fields between them', () => {
    const raw = '{"goal":{"title":"ND Translate"},"milestones":[{"title":"MVP","tasks":[{"title":"Manifest"},{"title":"Tests"},{"title":"README"}],"title":"Contract verification","description":"Review integrated files","tasks":[{"title":"Verify","dependsOn":["Manifest","Tests","README"]}]}]}'
    const { json, merged } = mergeRepeatedArrayKeys(raw, ['milestones', 'tasks'])
    const { plan, adjustments } = normalizeProjectPlan(JSON.parse(json))
    expect(plan.milestones[0]?.tasks.map((task) => task.title)).toEqual(['Manifest', 'Tests', 'README', 'Verify'])
    expect(plan.milestones[0]?.tasks[3]?.dependsOn).toEqual(['Manifest', 'Tests', 'README'])
    expect(merged).toBe(1)
    expect(adjustments).toEqual([])
  })

  it('merges only within the same object and leaves JSON-like quoted content untouched', () => {
    const raw = '{"milestones":[{"title":"A","tasks":[{"title":"a","description":"braces } ] and \\\"tasks\\\": []"}]},{"title":"B","tasks":[{"title":"b"}],"description":"c","tasks":[{"title":"c"}]}],"memory":[{"tasks":[1],"title":"nested","tasks":[2]}]}'
    const { json, merged } = mergeRepeatedArrayKeys(raw, ['tasks'])
    const parsed = JSON.parse(json)
    expect(parsed.milestones[0].tasks).toHaveLength(1)
    expect(parsed.milestones[0].tasks[0].description).toBe('braces } ] and "tasks": []')
    expect(parsed.milestones[1].tasks.map((task: { title: string }) => task.title)).toEqual(['b', 'c'])
    expect(parsed.memory[0].tasks).toEqual([1, 2])
    expect(merged).toBe(2)
  })

  it('does not expose prototype keys and rejects excessive nesting', () => {
    const { json } = mergeRepeatedArrayKeys('{"__proto__":{"polluted":true},"tasks":[],"description":"x","tasks":[1]}', ['tasks'])
    expect(JSON.parse(json).__proto__).toEqual({ polluted: true })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(() => mergeRepeatedArrayKeys('['.repeat(140) + '0' + ']'.repeat(140), ['tasks'])).toThrow(/nesting/)
  })

  it('merges milestones written as repeated keys instead of keeping only the last', () => {
    const raw = '{"goal":{"title":"G"},"milestones":[{"title":"A","tasks":[{"title":"a1"}]}],"milestones":[{"title":"B","tasks":[{"title":"b1"}],"tasks":[{"title":"b2"}]}],"milestones":[]}'
    const { json, merged } = mergeRepeatedArrayKeys(raw, ['milestones', 'tasks'])
    const parsed = JSON.parse(json)
    expect(parsed.milestones.map((item: { title: string }) => item.title)).toEqual(['A', 'B'])
    expect(parsed.milestones[1].tasks.map((item: { title: string }) => item.title)).toEqual(['b1', 'b2'])
    expect(merged).toBe(3)
  })

  it('leaves well-formed JSON untouched', () => {
    const raw = '{"milestones":[{"title":"A","tasks":[]}],"memory":[]}'
    expect(mergeRepeatedArrayKeys(raw, ['milestones', 'tasks'])).toEqual({ json: raw, merged: 0 })
  })
})

function task(title: string, extra: Record<string, unknown> = {}) {
  return { title, description: `${title} work`, ...extra }
}

describe('normalizeProjectPlan', () => {
  it('recovers actual repeated milestone producer lists into their final MVP ownership', () => {
    const producers = [
      task('Author manifest', { workScopes: ['nd-extension.json'], acceptanceCriteria: ['Native host contract matches'] }),
      task('Write tests', { workScopes: ['manifest.test.mjs'], acceptanceCriteria: ['Assert package invariants'] }),
      task('Write README', { workScopes: ['README.md'], acceptanceCriteria: ['Document install'] }),
      task('Install package', { artifactPaths: ['install-receipt.json'], evidenceKind: 'artifact', dependsOn: ['Author manifest'] }),
    ]
    const raw = { goal: { title: 'Build ND super apps' }, milestones: [
      { title: 'Folder install', description: 'Malformed first repeated list', tasks: [...producers, task('Independent producer', { workScopes: ['notes.md'] })] },
      { title: 'ND Translate MVP', description: 'Canonical final list', tasks: [
        ...producers.map((item) => Object.fromEntries(Object.entries(item).reverse())),
        task('Verify package', { dependsOn: ['Author manifest', 'Write tests', 'Write README', 'Install package'] }),
      ] },
    ] }
    const { plan, adjustments } = normalizeProjectPlan(raw, { recoverRepeatedLists: true })
    expect(plan.milestones[0]!.tasks.map((item) => item.title)).toEqual(['Independent producer'])
    expect(plan.milestones[1]!.tasks.map((item) => item.title)).toEqual([...producers.map((item) => item.title), 'Verify package'])
    expect(plan.milestones[1]!.tasks.at(-1)!.dependsOn).toEqual(['Author manifest', 'Write tests', 'Write README', 'Install package'])
    expect(adjustments[0]).toContain('Recovered 4 identical task(s)')
    expect(raw.milestones[0]!.tasks).toHaveLength(5)
    expect(normalizeProjectPlan(raw).plan.milestones[1]!.tasks[0]!.title).toBe('Author manifest (2)')
  })

  it('preserves distinct same-title tasks and intentional repeats within one original milestone', () => {
    const raw = { goal: { title: 'Build' }, milestones: [
      { title: 'First', tasks: [task('Setup'), task('Setup'), task('Distinct', { workScopes: ['a.ts'] })] },
      { title: 'Second', tasks: [task('Setup'), task('Distinct', { workScopes: ['b.ts'] })] },
    ] }
    const { plan } = normalizeProjectPlan(raw, { recoverRepeatedLists: true })
    expect(plan.milestones.flatMap((item) => item.tasks)).toHaveLength(5)
    expect(plan.milestones[1]!.tasks.map((item) => item.title)).toEqual(['Setup (3)', 'Distinct (2)'])
  })

  it.each([1, '2', 'T3', 'task #4'])('rejects ambiguous numeric reference %j only when recovery would shift indices', (reference) => {
    const raw = { goal: { title: 'Build' }, milestones: [
      { title: 'First', tasks: [task('Producer')] },
      { title: 'Second', tasks: [task('Producer'), task('Verify', { dependsOn: [reference] })] },
    ] }
    expect(() => normalizeProjectPlan(raw, { recoverRepeatedLists: true })).toThrow('numeric dependencies')
    expect(() => normalizeProjectPlan(raw)).not.toThrow()
    expect(() => normalizeProjectPlan({ ...raw, milestones: [raw.milestones[1]] }, { recoverRepeatedLists: true })).not.toThrow()
  })

  it('preserves 26 independent work scopes and joins only their real delivery dependency', () => {
    const titles = Array.from({ length: 26 }, (_, index) => `Feature ${String.fromCharCode(65 + index)}`)
    const { plan, adjustments } = normalizeProjectPlan({
      goal: { title: 'Build ND super apps' },
      milestones: [{ title: 'ND Translate', tasks: [
        ...titles.map((title, index) => task(title, { workScopes: [`src/translate/feature-${index}/**`] })),
        task('Verify ND Translate', { dependsOn: titles }),
      ] }],
    })
    const tasks = plan.milestones[0]!.tasks
    expect(tasks.slice(0, 26).every((item) => item.dependsOn === undefined)).toBe(true)
    expect(new Set(tasks.slice(0, 26).map((item) => item.workScopes?.[0])).size).toBe(26)
    expect(tasks[26]?.dependsOn).toEqual(titles)
    expect(adjustments).toEqual([])
  })

  it('keeps duplicate titles unique even when a model already used a generated suffix', () => {
    const { plan } = normalizeProjectPlan({
      goal: { title: 'ND super apps' },
      milestones: [{ title: 'ND Translate', tasks: [
        task('Setup'), task('Setup'), task('Setup (2)'), task('Setup'),
        task('Deliver', { dependsOn: ['Setup (2)'] }),
      ] }],
    })
    const tasks = plan.milestones[0]!.tasks
    const titles = tasks.map((item) => item.title)
    expect(new Set(titles).size).toBe(titles.length)
    expect(tasks.at(-1)?.dependsOn).toEqual(['Setup (2)'])
  })

  it('keeps a well-formed plan unchanged', () => {
    const { plan, adjustments } = normalizeProjectPlan({
      goal: { title: 'Launch', description: 'Ship v1' },
      milestones: [{ title: 'Build', description: '', tasks: [task('API'), task('UI', { dependsOn: ['API'], priority: 'high' })] }],
    })
    expect(adjustments).toEqual([])
    expect(plan.milestones[0]!.tasks[1]).toMatchObject({ title: 'UI', dependsOn: ['API'], priority: 'high' })
  })

  it('resolves dependencies by near title, number, and unique partial title', () => {
    const { plan, adjustments } = normalizeProjectPlan({
      goal: { title: 'Launch' },
      milestones: [{
        title: 'Build',
        tasks: [
          task('Design database schema'),
          task('Build REST API'),
          task('Write docs', { dependsOn: ['design database schema.', '2'] }),
          task('Ship', { dependsOn: ['REST API', 'Task 3'] }),
        ],
      }],
    })
    const tasks = plan.milestones[0]!.tasks
    expect(tasks[2]!.dependsOn).toEqual(['Design database schema', 'Build REST API'])
    expect(tasks[3]!.dependsOn).toEqual(['Build REST API', 'Write docs'])
    expect(plan.goal.description).toBe('Launch')
    expect(adjustments).toEqual([])
  })

  it('drops unknown and self dependencies and breaks cycles instead of rejecting the plan', () => {
    const { plan, adjustments } = normalizeProjectPlan({
      goal: { title: 'Launch', description: 'x' },
      milestones: [{
        title: 'Build',
        tasks: [
          task('A', { dependsOn: ['B', 'A', 'Something else entirely'] }),
          task('B', { dependsOn: ['A'] }),
        ],
      }],
    })
    const [a, b] = plan.milestones[0]!.tasks
    expect(a!.dependsOn).toEqual(['B'])
    expect(b!.dependsOn).toBeUndefined()
    expect(adjustments.join(' ')).toMatch(/unknown dependency/)
    expect(adjustments.join(' ')).toMatch(/self-dependency/)
    expect(adjustments.join(' ')).toMatch(/break a cycle/)
  })

  it('renames duplicate titles and drops empty tasks and milestones', () => {
    const { plan, adjustments } = normalizeProjectPlan({
      goal: { title: 'Launch', description: 'x' },
      milestones: [
        { title: 'One', tasks: [task('Setup'), task('Setup'), { title: '  ' }] },
        { title: 'Empty', tasks: [] },
      ],
    })
    expect(plan.milestones).toHaveLength(1)
    expect(plan.milestones[0]!.tasks.map((item) => item.title)).toEqual(['Setup', 'Setup (2)'])
    expect(adjustments).toHaveLength(3)
  })

  it('downgrades artifact evidence without paths and ignores invalid priorities', () => {
    const { plan } = normalizeProjectPlan({
      goal: { title: 'Launch', description: 'x' },
      milestones: [{ title: 'Docs', tasks: [task('Research', { evidenceKind: 'artifact', priority: 'urgent' })] }],
    })
    const research = plan.milestones[0]!.tasks[0]!
    expect(research.evidenceKind).toBeUndefined()
    expect(research.priority).toBeUndefined()
  })

  it('rejects only a plan with no goal title or no tasks', () => {
    expect(() => normalizeProjectPlan({ milestones: [] })).toThrow(/goal needs a title/)
    expect(() => normalizeProjectPlan({ goal: { title: 'X' }, milestones: [{ title: 'M', tasks: [] }] })).toThrow(/no tasks/)
  })
})
