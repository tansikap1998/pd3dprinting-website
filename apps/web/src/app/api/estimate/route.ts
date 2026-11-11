import { NextResponse } from 'next/server';
import { estimate } from '@/lib/estimate';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { volume, surfaceArea, height, infill, material, layerHeight, quantity } = body;

    if (!volume || !material || !infill || !layerHeight || !quantity) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    return NextResponse.json(estimate({ volume, surfaceArea, height, infill, material, layerHeight, quantity }), { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to estimate cost', details: String(error) }, { status: 500 });
  }
}
