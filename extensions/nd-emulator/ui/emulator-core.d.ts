/**
 * ND Emulator — pure logic module type declarations.
 */

export interface EmulatorDevice {
  serial: string
  type: string
  model: string
  product: string
  transportId: string
}

export function parseDeviceList(value: unknown): EmulatorDevice[]
export function formatDeviceInfo(device: Pick<EmulatorDevice, 'serial' | 'type' | 'model' | 'product'>): string
export function formatTimestamp(): string
