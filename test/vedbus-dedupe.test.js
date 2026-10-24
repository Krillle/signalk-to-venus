import { describe, it, expect, vi } from 'vitest'
import { VEDBusService } from '../vedbus.js'

function service() {
  return new VEDBusService(
    'test',
    { index: 0, name: 'Test' },
    {},
    {
      serviceType: 'tank',
      productName: 'Test',
      processName: 'test',
      additionalProperties: {},
    },
  )
}

describe('VEDBusService.updateProperty', () => {
  it('does not emit when the value is unchanged', () => {
    const svc = service()
    const emit = vi.fn()
    svc.isConnected = true
    svc.deviceData['/Level'] = 50
    svc.exportedInterfaces['/Level'] = { emit }
    svc.emitPropertiesChanged = vi.fn()
    svc.emitValueChanged = vi.fn()

    svc.updateProperty('/Level', 50, 'd', 'Level')

    expect(emit).not.toHaveBeenCalled()
    expect(svc.emitPropertiesChanged).not.toHaveBeenCalled()
  })

  it('emits exactly once when the value changes', () => {
    const svc = service()
    const emit = vi.fn()
    svc.isConnected = true
    svc.deviceData['/Level'] = 50
    svc.exportedInterfaces['/Level'] = { emit }
    svc.emitPropertiesChanged = vi.fn()
    svc.emitValueChanged = vi.fn()
    svc.bus = { invoke: vi.fn() }

    svc.updateProperty('/Level', 60, 'd', 'Level')

    // _exportProperty must not add its own signal; the single emit below is it.
    expect(emit).not.toHaveBeenCalled()
    expect(svc.emitPropertiesChanged).toHaveBeenCalledTimes(1)
    expect(svc.deviceData['/Level']).toBe(60)
  })

  it('still exports a property the first time it is seen', () => {
    const svc = service()
    svc.isConnected = true
    svc.bus = { exportInterface: vi.fn() }
    const spy = vi.spyOn(svc, '_exportProperty')

    svc.updateProperty('/Level', 50, 'd', 'Level')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(svc.deviceData['/Level']).toBe(50)
  })
})
