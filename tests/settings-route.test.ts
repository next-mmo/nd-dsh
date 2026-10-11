import { describe, expect, it } from 'vitest'
import { capabilitySubTabFromLocation, enginesSubTabFromLocation, generalSubTabFromLocation, settingsHash, settingsTabFromLocation } from '../src/renderer/src/lib/settings-route.js'

describe('settings route', () => {
  it('builds addressable model and extension settings tabs', () => {
    expect(settingsHash('models')).toBe('#/settings?tab=model')
    expect(settingsHash('extensions')).toBe('#/settings?tab=extensions')
    expect(settingsHash('general', 'workspace')).toBe('#/settings?tab=general&subtab=workspace')
    expect(settingsHash('general', 'shortcuts')).toBe('#/settings?tab=general&subtab=shortcuts')
    expect(settingsHash('capabilities', 'memory')).toBe('#/settings?tab=capabilities&subtab=memory')
  })

  it('reads settings tabs from the hash query', () => {
    expect(settingsTabFromLocation({ hash: '#/settings?tab=model', search: '' })).toBe('models')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=capabilities', search: '' })).toBe('capabilities')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=extensions', search: '' })).toBe('extensions')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=workspace', search: '' })).toBe('general')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=shortcuts', search: '' })).toBe('general')
  })

  it('reads general sub-tabs from location with runtime as default', () => {
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=general&subtab=workspace', search: '' })).toBe('workspace')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=runtime', search: '' })).toBe('runtime')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=browser', search: '' })).toBe('browser')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=shortcuts', search: '' })).toBe('shortcuts')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=general&subtab=shortcuts', search: '' })).toBe('shortcuts')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=about', search: '' })).toBe('about')
    expect(generalSubTabFromLocation({ hash: '#/settings?tab=general', search: '' })).toBe('runtime')
  })

  it('reads capability sub-tabs from location with engine as default', () => {
    expect(capabilitySubTabFromLocation({ hash: '#/settings?tab=capabilities&subtab=memory', search: '' })).toBe('memory')
    expect(capabilitySubTabFromLocation({ hash: '#/settings?tab=capabilities&subtab=context', search: '' })).toBe('context')
    expect(capabilitySubTabFromLocation({ hash: '#/settings?tab=capabilities&subtab=lifecycle', search: '' })).toBe('lifecycle')
    expect(capabilitySubTabFromLocation({ hash: '#/settings?tab=capabilities', search: '' })).toBe('engine')
  })

  it('parses coding engines sub-tabs', () => {
    expect(enginesSubTabFromLocation({ hash: '#/settings?tab=engines&subtab=gateway', search: '' })).toBe('gateway')
    expect(enginesSubTabFromLocation({ hash: '#/settings?tab=engines&subtab=tokens', search: '' })).toBe('tokens')
    expect(enginesSubTabFromLocation({ hash: '#/settings?tab=engines&subtab=token', search: '' })).toBe('tokens')
    expect(enginesSubTabFromLocation({ hash: '#/settings?tab=engines', search: '' })).toBe('engines')
  })

  it('accepts plural aliases and a regular query string', () => {
    expect(settingsTabFromLocation({ hash: '#/settings?tab=models', search: '' })).toBe('models')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=extensions', search: '' })).toBe('extensions')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=plugins', search: '' })).toBe('plugins')
    expect(settingsTabFromLocation({ hash: '#/settings?tab=plugin', search: '' })).toBe('plugins')
    expect(settingsTabFromLocation({ hash: '#/settings', search: '?tab=engine' })).toBe('engines')
  })

  it('falls back to General for unknown tabs', () => {
    expect(settingsTabFromLocation({ hash: '#/settings?tab=unknown', search: '' })).toBe('general')
  })
})
