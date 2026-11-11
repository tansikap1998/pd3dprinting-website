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

// ผนัง + ผิวบน/ล่าง: FDM ทั่วไปใช้ 2 perimeter (0.4mm × 2) และ top/bottom ~0.8mm → ถือว่าเปลือกหนา ~0.8 มม.
const SHELL_THICKNESS_CM = 0.08;
// อัตราฉีดเส้นเฉลี่ยรวมการเคลื่อนที่ (cm³ ของเนื้อพลาสติกต่อชั่วโมง) ที่ layer 0.2mm
const FDM_RATE_CM3_PER_HOUR = 12;
// Resin พิมพ์ทั้งชั้นพร้อมกัน เวลาขึ้นกับความสูงชิ้นงาน (~2.5 วินาที/ชั้น)
const RESIN_SECONDS_PER_LAYER = 2.5;

export type EstimateInput = {
  volume: number; // cm³
  surfaceArea?: number; // cm² (ถ้าไม่ส่งมา จะประมาณจากปริมาตรเหมือนลูกบาศก์)
  height?: number; // mm (ใช้คำนวณเวลาพิมพ์ Resin)
  infill: number;
  material: string;
  layerHeight: number;
  quantity: number;
};
export type EstimateResult = { weightG: number; printTimeMin: number; pricePerChip: number; total: number };

export function estimate({ volume, surfaceArea, height, infill, material, layerHeight, quantity }: EstimateInput): EstimateResult {
  const materialDensity = density[material] || 1.24;
  const materialPrice = pricePerGram[material] || 1.5;
  const isResin = material.startsWith('Resin');

  // เนื้อพลาสติกจริง = เปลือก (เต็ม 100%) + ด้านใน × infill
  const area = surfaceArea && surfaceArea > 0 ? surfaceArea : 6 * Math.cbrt(volume) ** 2;
  const shell = Math.min(volume, area * SHELL_THICKNESS_CM);
  const fill = isResin ? 1 : Math.min(1, Math.max(0, infill / 100));
  const materialVolume = shell + (volume - shell) * fill;
  const weightG = materialVolume * materialDensity;

  let printTimeHours: number;
  if (isResin) {
    const h = height && height > 0 ? height : Math.cbrt(volume) * 10;
    printTimeHours = (h / layerHeight) * RESIN_SECONDS_PER_LAYER / 3600 + 0.25; // + เวลาเตรียม/ยกฐาน
  } else {
    printTimeHours = materialVolume / (FDM_RATE_CM3_PER_HOUR * (layerHeight / 0.2)) + 0.1; // + heat-up / first layer
  }
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
