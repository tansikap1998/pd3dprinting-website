// คำนวณน้ำหนัก เวลา และราคา จากปริมาตรโมเดล (ใช้ร่วมกันทั้ง /api/estimate และ /api/order)

export const MATERIALS = {
  FDM: ['PLA', 'ABS', 'PETG'],
  Resin: ['Resin Standard', 'Resin Tough'],
} as const;
export const INFILLS = [10, 25, 50, 80];
export const LAYER_HEIGHTS = [0.12, 0.16, 0.2, 0.28];

// density (g/cm³)
const density: Record<string, number> = {
  PLA: 1.24,
  ABS: 1.04,
  PETG: 1.27,
  'Resin Standard': 1.1,
  'Resin Tough': 1.15,
};

// price per gram (THB)
const pricePerGram: Record<string, number> = {
  PLA: 1.5,
  ABS: 1.8,
  PETG: 2.0,
  'Resin Standard': 3.0,
  'Resin Tough': 3.5,
};

export type EstimateInput = { volume: number; infill: number; material: string; layerHeight: number; quantity: number };
export type EstimateResult = { weightG: number; printTimeMin: number; pricePerChip: number; total: number };

export function estimate({ volume, infill, material, layerHeight, quantity }: EstimateInput): EstimateResult {
  const materialDensity = density[material] || 1.24;
  const materialPrice = pricePerGram[material] || 1.5;

  // volume is in cm³
  const weightG = volume * materialDensity * (infill / 100);

  // Rough estimate: 15 cm³ per hour at 100% infill and 0.2mm layer height
  const baseSpeedCm3PerHour = 15;
  const layerHeightFactor = 0.2 / layerHeight; // thicker layers = faster
  const infillFactor = infill / 100; // less infill = faster
  const adjustedSpeed = baseSpeedCm3PerHour * layerHeightFactor * (1 / Math.max(0.2, infillFactor));

  let printTimeHours = volume / adjustedSpeed;
  if (printTimeHours < 0.5) printTimeHours = 0.5; // minimum time
  const printTimeMin = Math.round(printTimeHours * 60);

  // Price = material cost + machine time cost (20 THB/hour)
  const machineRatePerHour = 20;
  const totalPrice = weightG * materialPrice + printTimeHours * machineRatePerHour;

  return {
    weightG: Number(weightG.toFixed(2)),
    printTimeMin,
    pricePerChip: Math.ceil(totalPrice),
    total: Math.ceil(totalPrice) * quantity,
  };
}
