import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { volume, infill, material, layerHeight, quantity } = body;

    if (!volume || !material || !infill || !layerHeight || !quantity) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // density (g/cm³)
    const density: Record<string, number> = { 
      'PLA': 1.24, 
      'ABS': 1.04, 
      'PETG': 1.27,
      'Resin Standard': 1.1,
    };

    // price per gram (THB)
    const pricePerGram: Record<string, number> = { 
      'PLA': 1.5, 
      'ABS': 1.8, 
      'PETG': 2.0,
      'Resin Standard': 3.0,
    };

    const materialDensity = density[material] || 1.24;
    const materialPrice = pricePerGram[material] || 1.5;

    // Calculate actual weight based on volume and infill
    // volume is expected to be in cm³
    const weightG = volume * materialDensity * (infill / 100);

    // Rough estimate for print time (minutes)
    // Assuming a standard print speed
    const baseSpeedCm3PerHour = 15; // Rough estimate: 15 cm³ per hour at 100% infill and 0.2mm layer height
    
    // Adjust speed based on layer height (thicker layers = faster)
    const layerHeightFactor = 0.2 / layerHeight; 
    
    // Adjust speed based on infill (less infill = faster)
    const infillFactor = infill / 100;

    const adjustedSpeed = baseSpeedCm3PerHour * layerHeightFactor * (1 / Math.max(0.2, infillFactor));
    
    // Time in hours, then to minutes
    let printTimeHours = volume / adjustedSpeed;
    if (printTimeHours < 0.5) printTimeHours = 0.5; // minimum time

    const printTimeMin = Math.round(printTimeHours * 60);

    // Price calculation = material cost + machine time cost (e.g. 20 THB/hour)
    const machineRatePerHour = 20;
    const totalPrice = (weightG * materialPrice) + (printTimeHours * machineRatePerHour);

    return NextResponse.json({ 
      weightG: Number(weightG.toFixed(2)), 
      printTimeMin, 
      pricePerChip: Math.ceil(totalPrice), 
      total: Math.ceil(totalPrice) * quantity 
    }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: 'Failed to estimate cost', details: String(error) }, { status: 500 });
  }
}
