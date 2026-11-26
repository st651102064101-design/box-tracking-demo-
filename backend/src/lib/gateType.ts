/** Which way a gate may be used, from the warehouse master. */
export type GateType = 'in' | 'out' | 'both';

export function gateTypeOf(warehouse: unknown, gate: number | string): GateType {
  const wh = (warehouse ?? {}) as { gateType?: unknown; gateTypes?: Record<string, unknown> | null };
  const value = String(wh.gateTypes?.[String(gate)] ?? wh.gateType ?? 'both');
  return value === 'in' || value === 'out' ? value : 'both';
}
