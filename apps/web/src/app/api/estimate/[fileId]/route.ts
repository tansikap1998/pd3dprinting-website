import { NextResponse } from 'next/server';
import { calculatePrice } from '@/lib/pricing/pricing.service'; // We use the pricing service you defined!

export async function GET(req: Request, { params }: { params: { fileId: string } }) {
  try {
    const fileId = params.fileId;
    
    // Fetch result from the database (e.g. Prisma slicing_result table)
    // Simulated slicing result fetching
    const mockSlicingResult = {
      printTime: 14400, // 4 hours
      filamentUsed: 125, // grams
    };

    // Calculate dynamic cost utilizing the pricing engine
    const estimatedPrice = calculatePrice({ 
      filament: mockSlicingResult.filamentUsed, 
      time: mockSlicingResult.printTime 
    });

    return NextResponse.json({ 
      success: true, 
      estimate: estimatedPrice,
      details: mockSlicingResult
    }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: 'Failed to generate estimate.', details: String(error) }, { status: 500 });
  }
}
